import fs from "node:fs"
import fsp from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { execFileSync } from "node:child_process"
import path from "node:path"

// Force a deterministic interleaving around the real OS open in a disposable
// process. Stat/read/open are not mocked; only the timing of fixture renames is.
// All mutations are confined to this caller-created synthetic directory.
const [root, scenario] = process.argv.slice(2)
const modulePath = new URL("../registry-client.mjs", import.meta.url)
const registryDir = path.join(root, "registry")
fs.mkdirSync(registryDir, { mode: 0o700 })
const filename = path.join(registryDir, "fixture-entry.json")
const original = path.join(root, "original")
const replacement = path.join(root, "replacement")
fs.writeFileSync(filename, "{", { mode: 0o600 })
if (scenario === "fifo") execFileSync("mkfifo", ["-m", "600", replacement], { stdio: "ignore" })
else if (scenario === "symlink") fs.symlinkSync(original, replacement)
else fs.writeFileSync(replacement, '{"version":0}', { mode: scenario === "permissions" ? 0o666 : 0o600 })
if (scenario === "permissions") fs.chmodSync(replacement, 0o666)
const nativeOpen = fsp.open
let mutated = false
let opened = 0
let descriptorChecks = 0
let contentReads = 0
const swap = () => {
  fs.renameSync(filename, original)
  fs.renameSync(replacement, filename)
  mutated = true
}
fsp.open = async (target, ...args) => {
  if (target === filename && !mutated && !["after-open", "normal"].includes(scenario)) swap()
  const handle = await nativeOpen(target, ...args)
  if (target === filename) {
    opened++
    if (scenario === "after-open") swap()
    const nativeStat = handle.stat.bind(handle)
    const nativeRead = handle.read.bind(handle)
    handle.stat = async (...args) => { descriptorChecks++; return nativeStat(...args) }
    handle.read = async (...args) => { contentReads++; return nativeRead(...args) }
  }
  return handle
}
syncBuiltinESMExports()
const summary = (extra) => ({ scenario, mutated, opened, descriptorChecks, contentReads, ...extra })
try {
  const { inspectRegistry } = await import(modulePath)
  const result = await inspectRegistry({ registryDir, timeoutMs: 10 })
  process.stdout.write(JSON.stringify(summary({ timedOut: false, result })) + "\n")
} catch (error) {
  process.stdout.write(JSON.stringify(summary({ error: error.code ?? "unexpected_error" })) + "\n")
  process.exitCode = 1
}

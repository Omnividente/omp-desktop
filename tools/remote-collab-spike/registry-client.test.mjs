import assert from "node:assert/strict"
import { fork, execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { chmod, copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  inspectRegistry,
  ProbeError,
  requestPolicyChange,
  RUNTIME_CAPABILITIES,
  validateCapability,
  withCapability,
} from "./registry-client.mjs"

const cliPath = fileURLToPath(new URL("./probe.mjs", import.meta.url))
const childEnvironment = Object.fromEntries(
  ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
)

async function fixture(t) {
  const child = fork(new URL("./fixtures/host.mjs", import.meta.url), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: childEnvironment, execArgv: [],
  })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
      child.once("exit", () => { clearTimeout(timer); resolve() })
      if (child.connected) child.send({ type: "stop" }, () => {})
      else child.kill("SIGTERM")
    })
  })
  let serial = 0
  const pending = new Map()
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture_start_timeout")), 5000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", () => { clearTimeout(timer); reject(new Error("fixture_exited_before_ready")) })
    child.on("message", (message) => {
      if (message.type === "ready") { clearTimeout(timer); resolve(message) }
      else if (message.type === "setup_error") { clearTimeout(timer); reject(new Error("fixture_setup_" + message.code)) }
      else if (message.type === "reply") pending.get(message.id)?.(message)
    })
  })
  const command = (type, patch) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture_command_timeout")) }, 3000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      pending.delete(id)
      if (message.error) reject(new Error(message.error))
      else resolve(message)
    })
    child.send({ type, patch, id })
  })
  return {
    ...ready, child, command,
    options: { registryDir: ready.registryDir, timeoutMs: 1000 },
    expected: { instanceId: ready.instanceId, sessionId: ready.sessionId, generation: ready.generation },
  }
}

const acquire = (host, access = "view", consume = () => {}) => withCapability({
  ...host.options, expected: host.expected, access,
}, consume)
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error instanceof ProbeError && error.code === code && error.message === code)
const cli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [cliPath, ...args], { env: childEnvironment, timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, stdout, stderr })
  })
})
const cliLinkArgs = (host, access = "view") => [
  "check-link", "--registry-dir", host.registryDir, "--instance", host.instanceId,
  "--session", host.expected.sessionId, "--generation", String(host.expected.generation), "--access", access,
]

test("capability grammar accepts complete generated view/control links and custom relay wrappers", () => {
  const room = Buffer.alloc(16, 1).toString("base64url")
  for (const access of ["view", "control"]) {
    const key = Buffer.alloc(access === "view" ? 32 : 48, 2).toString("base64url")
    const bare = room + "." + key
    for (const inner of [
      bare, "relay.invalid/r/" + bare, "relay.invalid:9443/r/" + bare,
      "wss://relay.invalid/r/" + bare, "[::1]:9443/r/" + bare,
      "ws://127.0.0.1:9384/r/" + bare, "ws://[::1]:9384/r/" + bare,
    ]) {
      for (const outer of ["https://viewer.invalid/collab/", "http://localhost:9384/"]) {
        assert.doesNotThrow(() => validateCapability(outer + "#" + inner, access))
      }
    }
    assert.doesNotThrow(() => validateCapability("https://viewer.invalid/path%20name/#" + bare, access))
    assert.throws(() => validateCapability("https://viewer.invalid/#" + bare, access === "view" ? "control" : "view"), { code: "invalid_capability" })
  }
})

test("capability grammar rejects nested fragment privilege confusion and ambiguous relay paths", () => {
  const room = Buffer.alloc(16, 1).toString("base64url")
  const view = room + "." + Buffer.alloc(32, 2).toString("base64url")
  const control = Buffer.alloc(16, 3).toString("base64url") + "." + Buffer.alloc(48, 4).toString("base64url")
  const invalid = [
    "relay.invalid/r/" + control + "#x/" + view,
    "relay.invalid/r/" + control + "%23x/" + view,
    "relay.invalid/r/" + control + "%2523x/" + view,
    "relay.invalid/x/../r/" + view,
    "relay.invalid/extra/r/" + view,
    "relay.invalid/r/" + view + "/extra",
    "relay.invalid/r/" + view + "?",
    "relay.invalid/r/" + view + "?q=1",
    "user@relay.invalid/r/" + view,
    "ws://relay.invalid/r/" + view,
    "relay.invalid/%72/" + view,
    "relay.invalid\\r\\" + view,
  ]
  for (const inner of invalid) {
    assert.throws(() => validateCapability("https://viewer.invalid/#" + inner, "view"), { code: "invalid_capability" })
  }
  assert.throws(() => validateCapability("https://viewer.invalid/path%23name/#" + view, "view"), { code: "invalid_capability" })
})

test("filesystem inspection stays inside the explicit directory and preserves malformed metadata", async (t) => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), "ompr-fs-"))
  t.after(() => rm(registryDir, { recursive: true, force: true }))
  if (process.platform !== "win32") await chmod(registryDir, 0o700)
  const empty = await inspectRegistry({ registryDir })
  assert.deepEqual(empty, { version: 1, registryState: "ready", hosts: [], skipped: [] })
  const missing = await inspectRegistry({ registryDir: path.join(registryDir, "missing") })
  assert.equal(missing.registryState, "missing")
  const filename = path.join(registryDir, "invalid-entry.json")
  await writeFile(filename, "{", { mode: 0o600 })
  const malformed = await inspectRegistry({ registryDir })
  assert.deepEqual(malformed.skipped, [{ code: "invalid_metadata", count: 1 }])
  assert.equal(await readFile(filename, "utf8"), "{")
  await writeFile(filename, "x".repeat(4097))
  assert.deepEqual((await inspectRegistry({ registryDir })).skipped, [{ code: "metadata_limit", count: 1 }])
  assert.equal((await stat(filename)).size, 4097)
})

test("filesystem inspection refuses unsafe POSIX directory and metadata paths without following links", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ompr-fs-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const registryDir = await mkdtemp(path.join(parent, "registry-"))
  await chmod(registryDir, 0o700)
  const linkedDir = path.join(parent, "linked-registry")
  await symlink(registryDir, linkedDir)
  await rejectsCode(inspectRegistry({ registryDir: linkedDir }), "unsafe_registry")
  const sentinel = path.join(parent, "sentinel")
  await writeFile(sentinel, "preserve", { mode: 0o600 })
  await symlink(sentinel, path.join(registryDir, "symlink-entry.json"))
  assert.deepEqual((await inspectRegistry({ registryDir })).skipped, [{ code: "unsafe_metadata", count: 1 }])
  assert.equal(await readFile(sentinel, "utf8"), "preserve")
  await chmod(registryDir, 0o755)
  await rejectsCode(inspectRegistry({ registryDir }), "unsafe_registry")
})

test("filesystem metadata races reject replacements before reading and retain opened identity", { skip: process.platform === "win32" }, async (t) => {
  for (const [scenario, expectedCode, expectedReads] of [
    ["normal", "invalid_metadata", 1],
    ["regular", "unsafe_metadata", 0],
    ["symlink", "metadata_unavailable", 0],
    ["permissions", "unsafe_metadata", 0],
    ["after-open", "invalid_metadata", 1],
    ["fifo", "unsafe_metadata", 0],
  ]) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "ompr-race-"))
      t.after(() => rm(root, { recursive: true, force: true }))
      const worker = fileURLToPath(new URL("./fixtures/metadata-race.mjs", import.meta.url))
      const { error, stdout, stderr } = await new Promise((resolve) => {
        execFile(process.execPath, [worker, root, scenario], {
          env: childEnvironment, timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4096,
        }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      })
      // Parent-side process deadline remains effective even if a filesystem
      // worker blocks; timeoutMs only covers later host requests.
      assert.equal(error, null)
      assert.equal(stderr, "")
      const result = JSON.parse(stdout)
      assert.equal(result.mutated, scenario !== "normal")
      assert.equal(result.contentReads, expectedReads)
      assert.equal(result.descriptorChecks, scenario === "symlink" ? 0 : 1)
      assert.deepEqual(result.result, {
        version: 1, registryState: "ready", hosts: [],
        skipped: [{ code: expectedCode, count: 1 }],
      })
    })
  }
})

test("a separate process is discovered through real local IPC; private fields are dropped", async (t) => {
  const host = await fixture(t)
  const result = await inspectRegistry(host.options)
  assert.notEqual(host.pid, process.pid)
  assert.equal(result.registryState, "ready")
  assert.equal(result.hosts.length, 1)
  assert.equal(result.hosts[0].pid, host.pid)
  assert.equal(result.hosts[0].sessionId, host.sessionId)
  assert.equal(result.hosts[0].access, "control")
  assert.equal(result.hosts[0].busy, false)
  for (const field of ["cwd", "sessionName", "model", "token", "endpoint", "url"]) assert.equal(field in result.hosts[0], false)
  assert.deepEqual(result.skipped, [])
})

test("view/control capability reaches only the callback with the requested generation and access", async (t) => {
  const host = await fixture(t)
  for (const access of ["view", "control"]) {
    let seen = 0
    const result = await acquire(host, access, (url) => {
      seen++
      assert.equal(url, access === "view" ? host.viewUrl : host.controlUrl)
      return url // Callback return values must never leak through the public result.
    })
    assert.equal(seen, 1)
    assert.deepEqual(result, { instanceId: host.instanceId, generation: 1, access, capabilityChecked: true })
  }
  const { requests } = await host.command("stats")
  assert.deepEqual(requests.filter(({ op }) => op === "link").map(({ access, generation }) => ({ access, generation })), [
    { access: "view", generation: 1 }, { access: "control", generation: 1 },
  ])
})

test("a view host refuses control before any secret-bearing link request", async (t) => {
  const host = await fixture(t)
  await host.command("set", { access: "view" })
  await rejectsCode(acquire(host, "control"), "access_unavailable")
  assert.equal((await host.command("stats")).requests.filter(({ op }) => op === "link").length, 0)
  await acquire(host, "view")
})

test("changing caller/UI state during discovery cannot retarget or upgrade the captured request", async (t) => {
  const host = await fixture(t)
  const options = { ...host.options, expected: { ...host.expected }, access: "view" }
  let consumed
  const pending = withCapability(options, (url) => { consumed = url })
  options.expected.sessionId = "unrelated-session"
  options.expected.generation = 2
  options.access = "control"
  const result = await pending
  assert.equal(consumed, host.viewUrl)
  assert.equal(result.access, "view")
  assert.equal(result.generation, 1)
  assert.deepEqual((await host.command("stats")).requests.find(({ op }) => op === "link"), {
    op: "link", access: "view", generation: 1, authenticated: true,
  })
})

test("a stale dashboard generation is never silently upgraded", async (t) => {
  const host = await fixture(t)
  await host.command("set", { generation: 2 })
  await rejectsCode(acquire(host), "stale_generation")
  assert.equal((await host.command("stats")).requests.filter(({ op }) => op === "link").length, 0)
})

test("rotation between snapshot and link is rejected by the exact-generation request", async (t) => {
  const host = await fixture(t)
  await host.command("after_snapshot", { generation: 2, sessionId: "synthetic-session-b" })
  let consumed = false
  await rejectsCode(acquire(host, "view", () => { consumed = true }), "stale_generation")
  assert.equal(consumed, false)
  assert.equal((await host.command("stats")).requests.find(({ op }) => op === "link").generation, 1)
})

test("an unexpected session, instance or PID cannot inherit access", async (t) => {
  const host = await fixture(t)
  await host.command("set", { sessionId: "synthetic-session-b" })
  await rejectsCode(acquire(host), "session_mismatch")
  await host.command("set", { sessionId: host.sessionId, snapshotPid: host.pid + 1 })
  await rejectsCode(acquire(host), "identity_mismatch")
  await host.command("set", { snapshotPid: host.pid, snapshotInstanceId: "other-instance" })
  await rejectsCode(acquire(host), "identity_mismatch")
  assert.equal((await host.command("stats")).requests.filter(({ op }) => op === "link").length, 0)
})

test("authentication failure is explicit and metadata is not changed or pruned", async (t) => {
  const host = await fixture(t)
  const metadata = JSON.parse(await readFile(host.metadataPath, "utf8"))
  metadata.token = randomBytes(32).toString("hex")
  const replaced = JSON.stringify(metadata)
  await writeFile(host.metadataPath, replaced)
  await rejectsCode(acquire(host), "authentication_failed")
  const inspected = await inspectRegistry(host.options)
  assert.deepEqual(inspected.skipped, [{ code: "authentication_failed", count: 1 }])
  assert.equal(await readFile(host.metadataPath, "utf8"), replaced)
})

test("ambiguous live metadata fails closed instead of guessing a host", async (t) => {
  const host = await fixture(t)
  const duplicate = path.join(host.registryDir, "duplicate-entry.json")
  await copyFile(host.metadataPath, duplicate)
  if (process.platform !== "win32") await chmod(duplicate, 0o600)
  await rejectsCode(acquire(host), "ambiguous_host")
  assert.equal((await host.command("stats")).requests.filter(({ op }) => op === "link").length, 0)
  assert.ok(await stat(duplicate))
})

test("unknown busy remains null, and a disconnected relay is not ready for opening", async (t) => {
  const host = await fixture(t)
  await host.command("set", { behavior: "omit_busy" })
  assert.equal((await inspectRegistry(host.options)).hosts[0].busy, null)
  await host.command("set", { relayConnected: false })
  await rejectsCode(acquire(host), "relay_unavailable")
})

test("bounded transport handles fragmented replies and rejects malformed, oversized, incomplete or slow replies", async (t) => {
  const host = await fixture(t)
  await host.command("set", { behavior: "fragmented" })
  await acquire(host)
  for (const [behavior, code] of [
    ["malformed", "invalid_response"], ["oversized", "response_limit"],
    ["missing_newline", "incomplete_response"], ["unsupported_version", "unsupported_protocol"],
    ["timeout", "host_timeout"], ["secret_error", "host_refused"],
  ]) {
    await host.command("set", { behavior })
    await rejectsCode(withCapability({ ...host.options, timeoutMs: 100, expected: host.expected, access: "view" }, () => {}), code)
  }
})

test("the returned capability must encode the requested access and an accepted browser URL", async (t) => {
  const host = await fixture(t)
  for (const behavior of ["wrong_access_key", "invalid_capability", "nested_fragment", "encoded_nested_fragment"]) {
    await host.command("set", { behavior })
    let consumed = false
    await rejectsCode(acquire(host, "view", () => { consumed = true }), "invalid_capability")
    assert.equal(consumed, false)
  }
  await host.command("set", { behavior: "custom_web_url" })
  await acquire(host)
})

test("consumer failures cannot propagate a secret-bearing exception", async (t) => {
  const host = await fixture(t)
  await rejectsCode(acquire(host, "view", (url) => { throw new Error(url) }), "consumer_failed")
})

test("a missing registry is distinct from an unavailable host; no files are pruned", async (t) => {
  const host = await fixture(t)
  const missing = await inspectRegistry({ registryDir: path.join(host.registryDir, "missing") })
  assert.deepEqual(missing, { version: 1, registryState: "missing", hosts: [], skipped: [] })
  await host.command("close_endpoint")
  const result = await inspectRegistry(host.options)
  assert.equal(result.hosts.length, 0)
  assert.deepEqual(result.skipped, [{ code: "host_unreachable", count: 1 }])
  assert.ok(await stat(host.metadataPath))
})

test("a bad entry does not prevent healthy peers from being inspected", async (t) => {
  const host = await fixture(t)
  const bad = path.join(host.registryDir, "invalid-entry.json")
  await writeFile(bad, "{", { mode: 0o600 })
  const result = await inspectRegistry(host.options)
  assert.equal(result.hosts.length, 1)
  assert.deepEqual(result.skipped, [{ code: "invalid_metadata", count: 1 }])
  assert.equal(await readFile(bad, "utf8"), "{")
  await writeFile(bad, "x".repeat(4097))
  assert.deepEqual((await inspectRegistry(host.options)).skipped, [{ code: "metadata_limit", count: 1 }])
})

test("registry and metadata symlinks or non-private permissions are refused on POSIX", { skip: process.platform === "win32" }, async (t) => {
  const host = await fixture(t)
  const outside = await mkdtemp(path.join(os.tmpdir(), "ompr-links-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const registryLink = path.join(outside, "registry-link")
  await symlink(host.registryDir, registryLink)
  await rejectsCode(inspectRegistry({ registryDir: registryLink }), "unsafe_registry")
  await symlink(host.metadataPath, path.join(host.registryDir, "symlink-entry.json"))
  assert.deepEqual((await inspectRegistry(host.options)).skipped, [{ code: "unsafe_metadata", count: 1 }])
  await chmod(host.metadataPath, 0o644)
  assert.equal((await inspectRegistry(host.options)).hosts.length, 0)
})

test("CLI success and failure output never contains links, tokens, titles, paths or raw session IDs", async (t) => {
  const host = await fixture(t)
  const privateSessionId = "private-fixture-session-id"
  await host.command("set", { sessionId: privateSessionId })
  host.expected.sessionId = privateSessionId
  const inspect = await cli(["inspect", "--registry-dir", host.registryDir])
  assert.equal(inspect.code, 0)
  const inspected = JSON.parse(inspect.stdout)
  assert.equal(inspected.hosts[0].sessionFingerprint, createHash("sha256").update(privateSessionId).digest("hex"))
  assert.equal("sessionId" in inspected.hosts[0], false)
  const checked = await cli(cliLinkArgs(host))
  assert.equal(checked.code, 0)
  assert.equal(JSON.parse(checked.stdout).capabilityChecked, true)
  await host.command("set", { behavior: "secret_error" })
  const refused = await cli(cliLinkArgs(host))
  assert.equal(refused.code, 1)
  assert.deepEqual(JSON.parse(refused.stderr), { ok: false, code: "host_refused" })
  const combined = inspect.stdout + inspect.stderr + checked.stdout + checked.stderr + refused.stdout + refused.stderr
  for (const value of [host.token, host.viewUrl, host.controlUrl, host.endpoint, host.registryDir, privateSessionId, "private-fixture-title", "/private-fixture-working-directory"]) {
    assert.equal(combined.includes(value), false, "CLI output disclosed a private fixture field")
  }
})

test("CLI requires an explicit registry and rejects invalid, duplicate or unexpected options", async () => {
  for (const args of [[], ["inspect"], ["inspect", "--registry-dir", "."], ["inspect", "--registry-dir", "/one", "--registry-dir", "/two"], ["inspect", "--registry-dir", "/one", "--output", "secret"], ["inspect", "--registry-dir", "/one", "--timeout-ms", "0"]]) {
    const result = await cli(args)
    assert.equal(result.code, 2)
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: "invalid_arguments" })
    assert.equal(result.stdout, "")
  }
})

test("unsupported live mutations return a failure, never simulated success", async () => {
  assert.equal(RUNTIME_CAPABILITIES.start, false)
  assert.equal(RUNTIME_CAPABILITIES.stop, false)
  assert.equal(RUNTIME_CAPABILITIES.setAccess, false)
  assert.throws(() => requestPolicyChange(), (error) => error.code === "runtime_control_unavailable")
  for (const command of ["start", "stop", "set-access"]) {
    const result = await cli([command])
    assert.equal(result.code, 3)
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: "runtime_control_unavailable" })
    assert.equal(result.stdout, "")
  }
})

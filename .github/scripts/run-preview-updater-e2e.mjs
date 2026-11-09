import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { compareStableVersions, parseWindowsExecutableVersion } from "./run-updater-e2e.mjs"

// Only isolated test-key packages built from this source use this fixture. Never production trust.
const host = "127.0.0.1"
const port = 17823
const repository = "Omnividente/omp-desktop"
const origin = `http://${host}:${port}`
const appIdentity = "com.ompdesk.desktop.updater-e2e"
const subprocessTimeout = 90_000
const powershell = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null
const normalizedPath = path => process.platform === "win32" && path.startsWith("\\\\?\\") ? path.slice(4) : path
const descendant = (parent, path) => { const child = relative(normalizedPath(parent), normalizedPath(path)); return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) }
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
async function fileHash(path) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}
async function filesIn(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await filesIn(child))
    else if (entry.isFile()) result.push(child)
  }
  return result
}
function single(files, predicate, description) {
  const found = files.filter(predicate)
  requireThat(found.length === 1, `Expected one ${description}, found ${found.length}`)
  return found[0]
}
function childEnvironment(root) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|USERNAME|USERDOMAIN|LOGONSERVER|LANG|LC_ALL|DISPLAY|XAUTHORITY)$/i.test(key)))
  environment.PATH = process.platform === "win32" ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : "/usr/bin:/bin"
  environment.HOME = environment.USERPROFILE = join(root, "home")
  environment.TEMP = environment.TMP = environment.TMPDIR = join(root, "temp")
  environment.APPDATA = join(root, "config")
  environment.LOCALAPPDATA = join(root, "local")
  environment.XDG_CONFIG_HOME = join(root, "config")
  environment.XDG_DATA_HOME = join(root, "data")
  environment.XDG_CACHE_HOME = join(root, "cache")
  environment.XDG_RUNTIME_DIR = join(root, "runtime")
  environment.OMP_DESKTOP_UPDATER_E2E_MODE = "channels"
  environment.OMP_DESKTOP_UPDATER_E2E_RELEASES_URL = `${origin}/releases`
  return environment
}
async function execute(command, args, environment, timeout = subprocessTimeout) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    const collect = chunk => { if (output.length < 64 * 1024) output += chunk.toString() }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Owned subprocess timed out: ${basename(command)}`)) }, timeout)
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else reject(new Error(`Owned subprocess ${basename(command)} failed: ${code}/${signal}: ${output}`))
    })
  })
}

async function guardWindowsConfig(root, environment) {
  const config = join(root, "config", appIdentity)
  await mkdir(config, { recursive: true })
  // dirs/SHGetKnownFolderPath may ignore APPDATA. Resolve that actual directory, not a guess.
  const roaming = (await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write([Environment]::GetFolderPath('ApplicationData'))"], environment)).trim()
  requireThat(isAbsolute(roaming), "Could not resolve the Windows Roaming known folder")
  const link = join(roaming, appIdentity)
  if (descendant(root, link)) { await mkdir(link, { recursive: true }); return async () => {} }
  try { await lstat(link); throw new Error("E2E app identity already exists; refusing to touch any existing profile") }
  catch (error) { if (error.code !== "ENOENT") throw error }
  const ownedTarget = await realpath(config)
  requireThat(descendant(await realpath(root), ownedTarget), "E2E config escaped the owned root")
  await symlink(config, link, "junction")
  const remove = async () => {
    // Delete only our unchanged reparse point, never its target or a pre-existing profile.
    const entry = await lstat(link)
    requireThat(entry.isSymbolicLink() && await realpath(link) === ownedTarget, "E2E junction changed; refusing cleanup")
    await rmdir(link)
  }
  try { requireThat(await realpath(link) === ownedTarget, "E2E junction does not resolve to its owned target") }
  catch (error) { await remove(); throw error }
  return remove
}

async function stopOwnedApps(root, executable, environment) {
  if (process.platform === "win32" && executable) {
    // Includes the SDK/NSIS-relaunched app, but never matches by production process name.
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($env:OMP_E2E_EXECUTABLE,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    requireThat(descendant(root, executable) && basename(executable).toLowerCase() === "omp-desktop-updater-e2e.exe", "Refusing unowned process cleanup")
    await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { ...environment, OMP_E2E_EXECUTABLE: executable })
  } else if (process.platform === "linux") {
    // Relaunch may change PID/AppImage mount path. Only our unique marker command line owns it.
    for (const entry of await readdir("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      try {
        const args = (await readFile(`/proc/${entry.name}/cmdline`, "utf8")).split("\0")
        if (args.includes(`--updater-e2e-marker=${join(root, "channel-events.jsonl")}`) && args.includes("--updater-e2e-mode=channels")) process.kill(Number(entry.name), "SIGKILL")
      } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error }
    }
  }
}
function wrongKeySignature(signature) {
  const lines = Buffer.from(signature.trim(), "base64").toString("utf8").trimEnd().split("\n")
  const packet = Buffer.from(lines[1], "base64")
  requireThat(packet.length >= 74, "Test signature packet is incomplete")
  packet[2] ^= 1
  lines[1] = packet.toString("base64")
  return Buffer.from(`${lines.join("\n")}\n`).toString("base64")
}
async function prepareFixture(targetFiles, targetVersion) {
  const packages = new Map()
  for (const [platform, pattern] of [["linux-x86_64", /\.AppImage$/], ["windows-x86_64", /-setup\.exe$/i]]) {
    const path = single(targetFiles, file => pattern.test(file), `${platform} signed test artifact`)
    const signaturePath = single(targetFiles, file => file === `${path}.sig`, `${platform} test signature`)
    const size = (await stat(path)).size
    const name = basename(path).replaceAll(" ", ".")
    packages.set(name, { id: packages.size + 1, path, platform, size, sha256: await fileHash(path), signature: (await readFile(signaturePath, "utf8")).trim() })
  }
  let fixtureCase = "preview"
  let holdNext = false
  let held = null
  let assetRequests = 0
  let metadataRequests = 0
  const holdWaiters = new Set()
  const streams = new Set()
  const sockets = new Set()
  const binaryResponses = []
  const counters = () => ({ assetRequests, metadataRequests, holdPending: !!held, binaryResponses })
  const prefix = `/releases/download/v${targetVersion}/`
  function snapshot() {
    const content = new Map()
    const platforms = {}
    for (const [name, asset] of packages) {
      const signature = fixtureCase === "wrong-key" ? wrongKeySignature(asset.signature) : asset.signature
      content.set(`${name}.sig`, Buffer.from(signature))
      platforms[fixtureCase === "wrong-platform" ? `unsupported-${asset.platform}` : asset.platform] = { signature, url: `${origin}/releases/assets/${asset.id}` }
    }
    const manifest = { version: targetVersion, notes: "Owned test-key Desktop channel fixture", pub_date: "2026-11-08T00:00:00Z", platforms }
    content.set("latest.json", Buffer.from(JSON.stringify(manifest)))
    for (const family of ["linux", "windows"]) content.set(`SHA256SUMS-${family}.txt`, Buffer.from([...packages].filter(([, asset]) => asset.platform.startsWith(family)).map(([name, asset]) => `${asset.sha256}  ${name}\n`).join("")))
    if (fixtureCase === "unsigned") content.delete(`${packages.keys().next().value}.sig`)
    const inventory = []
    for (const [name, asset] of packages) inventory.push({ id: asset.id, name, state: "uploaded", size: asset.size, digest: `sha256:${asset.sha256}`, content_type: "application/octet-stream", browser_download_url: `${origin}${prefix}${encodeURIComponent(name)}`, url: `${origin}/releases/assets/${asset.id}` })
    for (const [name, body] of content) inventory.push({ id: inventory.length + 1, name, state: "uploaded", size: body.length, digest: `sha256:${hash(body)}`, content_type: name.endsWith(".json") ? "application/json" : "text/plain", browser_download_url: `${origin}${prefix}${encodeURIComponent(name)}`, url: `${origin}/releases/assets/${inventory.length + 1}` })
    const assets = inventory.map(asset => ({ name: asset.name, kind: asset.name === "latest.json" ? "updater-manifest" : asset.name.endsWith(".sig") ? "signature" : asset.name.startsWith("SHA256SUMS-") ? "checksum" : "installer", platform: /\.AppImage(?:\.sig)?$/.test(asset.name) ? "linux" : /setup\.exe(?:\.sig)?$/i.test(asset.name) ? "windows" : "metadata", bytes: asset.size, sha256: asset.digest.slice(7), downloadUrl: asset.browser_download_url }))
    const releaseManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: targetVersion, tag: `v${targetVersion}`, repository, generatedAt: "2026-11-08T00:00:00Z", assets }))
    content.set("release-assets-manifest.json", releaseManifest)
    inventory.push({ id: inventory.length + 1, name: "release-assets-manifest.json", state: "uploaded", size: releaseManifest.length, digest: `sha256:${hash(releaseManifest)}`, content_type: "application/json", browser_download_url: `${origin}${prefix}release-assets-manifest.json`, url: `${origin}/releases/assets/${inventory.length + 1}` })
    if (fixtureCase === "incomplete") inventory.splice(inventory.findIndex(asset => asset.name === "latest.json"), 1)
    return { release: { id: 101, tag_name: fixtureCase === "old" ? "v0.0.1" : `v${targetVersion}`, draft: false, immutable: true, prerelease: fixtureCase !== "stable", published_at: "2026-11-08T00:00:00Z", html_url: `https://github.com/${repository}/releases/tag/${fixtureCase === "old" ? "v0.0.1" : `v${targetVersion}`}`, body: "Synthetic signed updater fixture; not a published production release", assets: inventory }, content }
  }
  const sendJson = (response, value) => { const body = Buffer.from(JSON.stringify(value)); response.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length }); response.end(body) }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin)
      if (url.pathname === "/control" && request.method === "POST") {
        let data = ""
        for await (const chunk of request) { data += chunk; requireThat(data.length < 4096, "Oversized fixture command") }
        const command = JSON.parse(data)
        if (command.case) { requireThat(["preview", "stable", "unsigned", "wrong-key", "wrong-platform", "incomplete", "old"].includes(command.case), "Unknown fixture case"); fixtureCase = command.case }
        if (command.holdNext) holdNext = true
        if (command.releaseHold) {
          requireThat(held && !held.response.destroyed, "No live held check response")
          const saved = held
          held = null
          sendJson(saved.response, saved.body)
        }
        sendJson(response, { fixtureCase, ...counters() })
        return
      }
      if (request.method !== "GET") { response.writeHead(405); response.end(); return }
      if (url.pathname === "/probe") {
        if (url.searchParams.get("awaitHold") === "1" && !held) {
          // Acknowledge only when the native check has actually entered its held HTTP request.
          // Event-driven; the native HTTP client's 30s timeout also bounds this handshake.
          const ready = () => { clearTimeout(timer); holdWaiters.delete(ready); sendJson(response, { fixtureCase, ...counters() }) }
          const timer = setTimeout(() => { holdWaiters.delete(ready); response.writeHead(504); response.end("Native held request did not arrive") }, 25_000)
          holdWaiters.add(ready)
          response.once("close", () => { clearTimeout(timer); holdWaiters.delete(ready) })
        } else sendJson(response, { fixtureCase, ...counters() })
        return
      }
      if (url.pathname === "/releases" || url.pathname === "/releases/101") {
        metadataRequests++
        const body = url.pathname === "/releases/101" ? snapshot().release : url.searchParams.get("page") === "2" ? [] : [snapshot().release]
        if (holdNext && url.pathname === "/releases") {
          holdNext = false
          requireThat(!held, "Only one held native check is allowed")
          // Retain the request-time snapshot, never recompute it on releaseHold.
          const saved = { response, body }
          held = saved
          response.once("close", () => { if (held === saved) held = null })
          for (const ready of [...holdWaiters]) ready()
          return
        }
        sendJson(response, body)
        return
      }
      const current = snapshot()
      const name = url.pathname.startsWith(prefix)
        ? decodeURIComponent(url.pathname.slice(prefix.length))
        : url.pathname.startsWith("/releases/assets/")
          ? current.release.assets.find(asset => String(asset.id) === url.pathname.slice("/releases/assets/".length))?.name
          : undefined
      if (name !== undefined) {
        const metadata = current.content.get(name)
        if (metadata) { response.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "text/plain", "Content-Length": metadata.length }); response.end(metadata); return }
        const asset = packages.get(name)
        if (asset) {
          assetRequests++
          if (assetRequests === 1) {
            binaryResponses.push({ name, status: 503, kind: "http-failure" })
            response.writeHead(503); response.end("Owned pre-install download failure"); return
          }
          if (assetRequests === 2) {
            binaryResponses.push({ name, status: 200, kind: "corrupt-package" })
            response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end("Owned corrupt package: signature must reject it"); return
          }
          requireThat(assetRequests === 3, "Unexpected fourth binary GET")
          binaryResponses.push({ name, status: 200, kind: "signed-package", sha256: asset.sha256 })
          response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": asset.size })
          const stream = createReadStream(asset.path)
          streams.add(stream)
          stream.once("close", () => streams.delete(stream))
          stream.once("error", error => response.destroy(error))
          response.once("close", () => stream.destroy())
          stream.pipe(response)
          return
        }
      }
      response.writeHead(404); response.end("unknown owned fixture route")
    } catch { if (!response.headersSent) response.writeHead(500); response.end("Fixture failure") }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 30_000
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(port, host, resolvePromise) })
  return {
    counters,
    async close() {
      held?.response.destroy()
      held = null
      for (const stream of streams) stream.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolvePromise => { server.close(resolvePromise); server.closeAllConnections() })
    },
  }
}

async function main() {
  requireThat(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Native installer E2E requires its fresh hosted test VM, never a working Desktop")
  const { E2E_BASE_DIR, E2E_TARGET_DIR, E2E_BASE_VERSION, E2E_TARGET_VERSION, E2E_WORK_DIR, E2E_SOURCE_SHA } = process.env
  requireThat(E2E_BASE_DIR && E2E_TARGET_DIR && E2E_BASE_VERSION && E2E_TARGET_VERSION && E2E_WORK_DIR && /^[a-f0-9]{40}$/.test(E2E_SOURCE_SHA || ""), "Missing pinned fixture inputs/source SHA")
  const source = (await execute("git", ["rev-parse", "HEAD"], process.env)).trim()
  requireThat(source === E2E_SOURCE_SHA, "Harness checkout is not the exact target source SHA")
  const identity = JSON.parse(await readFile("src-tauri/tauri.updater-e2e.conf.json", "utf8"))
  requireThat(identity.identifier === appIdentity && identity.mainBinaryName === "omp-desktop-updater-e2e", "Harness identity differs from the isolated bundle config")
  requireThat(compareStableVersions(E2E_TARGET_VERSION, E2E_BASE_VERSION) > 0, "Test target must be newer")
  await mkdir(resolve(E2E_WORK_DIR), { recursive: true })
  const root = await mkdtemp(join(resolve(E2E_WORK_DIR), "preview-"))
  const environment = childEnvironment(root)
  for (const key of ["HOME", "TEMP", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) await mkdir(environment[key], { recursive: true, mode: 0o700 })
  if (process.platform === "win32") {
    // SHGetKnownFolderPath expands USERPROFILE, not the APPDATA/LOCALAPPDATA overrides.
    // Without Local's directory Windows returns an unknown path before WebView startup.
    for (const name of ["Local", "Roaming"]) await mkdir(join(environment.USERPROFILE, "AppData", name), { recursive: true })
  }
  await mkdir(join(root, "config", appIdentity), { recursive: true, mode: 0o700 })
  const marker = join(root, "channel-events.jsonl")
  environment.OMP_DESKTOP_UPDATER_E2E_MARKER = marker
  environment.OMP_DESKTOP_UPDATER_E2E_TARGET = E2E_TARGET_VERSION
  let fixture
  let removeConfigJunction
  let output = ""
  let events = []
  let executable
  let child
  try {
    if (process.platform === "win32") removeConfigJunction = await guardWindowsConfig(root, environment)
    fixture = await prepareFixture(await filesIn(E2E_TARGET_DIR), E2E_TARGET_VERSION)
    const baseFiles = await filesIn(E2E_BASE_DIR)
    if (process.platform === "win32") {
      const installer = single(baseFiles, path => /-setup\.exe$/i.test(path), "owned base installer")
      const installation = join(root, "installed")
      await mkdir(installation)
      await execute(installer, ["/S", `/D=${installation}`], environment)
      executable = single(await filesIn(installation), path => basename(path).toLowerCase() === "omp-desktop-updater-e2e.exe", "owned installed test binary")
    } else {
      requireThat(process.platform === "linux", "Unsupported fixture OS")
      executable = join(root, "probe.AppImage")
      await copyFile(single(baseFiles, path => /\.AppImage$/.test(path), "owned base AppImage"), executable)
      await chmod(executable, 0o700)
    }
    const args = [`--updater-e2e-marker=${marker}`, `--updater-e2e-target=${E2E_TARGET_VERSION}`, "--updater-e2e-mode=channels", `--updater-e2e-releases-url=${origin}/releases`]
    child = spawn(executable, args, { env: environment, cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const collect = chunk => { if (output.length < 128 * 1024) output += chunk.toString() }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    let launchError
    child.once("error", error => { launchError = error })
    const deadline = Date.now() + 6 * 60 * 1000
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      try {
        const text = await readFile(marker, "utf8")
        // A concurrently appended final row is not complete until its newline is present.
        events = text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      } catch(error) { if (error.code !== "ENOENT") throw error }
      const failure = events.find(event => event.event === "error")
      requireThat(!failure, `Native broker fixture error: ${failure?.detail}`)
      requireThat(child.exitCode === null || child.exitCode === 0, `Owned native app exited ${child.exitCode}: ${output}`)
      if (events.some(event => event.event === "channels-complete" && event.version === E2E_TARGET_VERSION)) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
    }
    const expected = ["channels-started", "stable-default", "preview-opt-in", "held-check-observed", "retired-candidate-refused", "channel-late-result-discarded", "unknown-save-reconciled", "invalid-releases-rejected", "stable-flag-offer", "download-failure-safe", "signature-failure-safe", "install-requested", ...(process.platform === "linux" ? ["installed-reused"] : []), "channels-complete"]
    let previous = -1
    for (const name of expected) { const index = events.findIndex(event => event.event === name); requireThat(index > previous, `Missing/out-of-order actual native stage: ${name}`); previous = index }
    const starts = events.filter(event => event.event === "channels-started")
    requireThat(starts.length === 2 && starts[0].version === E2E_BASE_VERSION && starts[1].version === E2E_TARGET_VERSION && starts[0].pid !== starts[1].pid, "Actual version/process restart not observed")
    for (const start of starts) {
      requireThat(start.detail.source === source && descendant(await realpath(root), start.detail.configDir), "Native bundle source/config isolation does not match the owned exact-source fixture")
    }
    const rejected = events.filter(event => event.event === "invalid-release-rejected")
    requireThat(JSON.stringify(rejected.map(event => event.detail.case)) === JSON.stringify(["unsigned", "wrong-key", "wrong-platform", "incomplete", "old"]) && rejected.every(event => event.detail.fixture.assetRequests === 0), "Incomplete actual native rejection inventory")
    requireThat(fixture.counters().assetRequests === 3, "Unexpected binary GET count: discovery/retry must not install or redownload again")
    if (process.platform === "linux") requireThat(events.some(event => event.event === "installed-reused"), "Confirmed installation retry not observed")
    const states = events.filter(event => event.event === "native-state")
    requireThat(states.some(event => event.detail.policyState === "uncertain" && event.detail.includePrereleases === null && event.detail.update === null), "No actual uncertain-policy broker event observed")
    requireThat(states.some(event => event.detail.installState === "downloading") && states.some(event => event.detail.installState === "installing"), "No actual SDK download/install broker transitions observed")
    for (const start of starts) {
      const revisions = states.filter(event => event.pid === start.pid).map(event => BigInt(event.detail.revision))
      requireThat(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]), "Actual broker event revisions are not strictly increasing per process")
    }
    const responses = fixture.counters().binaryResponses
    requireThat(responses.length === 3 && responses[0].status === 503 && responses[1].kind === "corrupt-package" && responses[2].kind === "signed-package", "Actual HTTP failure/corruption/valid-package sequence missing")
    requireThat(events.find(event => event.event === "download-failure-safe").detail.fixture.assetRequests === 1 && events.find(event => event.event === "signature-failure-safe").detail.fixture.assetRequests === 2, "Native SDK failures did not correspond to the actual served bytes")
    let installedIdentity
    if (process.platform === "win32") {
      const script = "$item=Get-Item -LiteralPath $env:OMP_E2E_EXECUTABLE; [Console]::Out.Write($item.VersionInfo.ProductVersion)"
      const version = parseWindowsExecutableVersion(await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { ...environment, OMP_E2E_EXECUTABLE: executable }))
      requireThat(version === E2E_TARGET_VERSION, "Installed PE version mismatch")
      installedIdentity = { kind: "PE-product-version", version }
    } else {
      const target = single(await filesIn(E2E_TARGET_DIR), path => /\.AppImage$/.test(path), "target AppImage")
      const installedHash = await fileHash(executable)
      requireThat(installedHash === await fileHash(target), "Installed AppImage bytes do not match the signed target")
      installedIdentity = { kind: "AppImage-sha256", sha256: installedHash }
    }
    const proof = { status: "PASS", source, scenario: "actual-native-broker-channels-test-key", platform: process.platform, baseVersion: E2E_BASE_VERSION, targetVersion: E2E_TARGET_VERSION, binaryRequests: fixture.counters().assetRequests, binaryResponses: responses, installedIdentity, events, limits: ["Synthetic same-source test-version overlay, not production assets or an old stable binary", "Native Rust broker/SDK, not rendered UI", "Test trust only; production trust unchanged", "NSIS and AppImage only; no DEB/RPM/MSI install proof"] }
    await writeFile(join(resolve(E2E_WORK_DIR), "preview-updater-proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" })
    console.log(JSON.stringify(proof))
  } finally {
    try { await stopOwnedApps(root, executable, environment) }
    finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      try { await fixture?.close() }
      finally {
        try { await removeConfigJunction?.() }
        finally {
          await writeFile(join(resolve(E2E_WORK_DIR), "native-output.log"), output)
          await copyFile(marker, join(resolve(E2E_WORK_DIR), "native-events.jsonl")).catch(error => { if (error.code !== "ENOENT") throw error })
        }
      }
    }
  }
}
await main()

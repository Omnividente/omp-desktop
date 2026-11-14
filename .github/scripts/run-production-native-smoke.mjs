// Production Linux normal AppImage replacement OR separate Windows/Linux
// production-trust broker/SDK update. Every target is an unmodified release asset.
// Native UI is observed via OS accessibility, including FIRST SDK relaunch.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const windows = process.platform === "win32"
const harness = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const required = (key) => {
  assert(process.env[key], `Missing ${key}`)
  return process.env[key]
}
const same = (a, b) =>
  windows ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
const inside = (root, path) => {
  const p = relative(root, path)
  return p && p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p)
}
const result = {
  status: "FAIL",
  launches: [],
  installers: [],
  limits: [
    "Fresh hosted VM synthetic data only; real runtime setup/help but no provider inference or credentials.",
    "Shipped stable12 NSIS/AppImage replacement and same-source diagnostic PROBE12 SDK upgrade are distinct proofs.",
    "Stable-only discovery must stay12; candidate13 requires an explicit durable prerelease opt-in.",
    "Native accessibility/window unavailability fails closed; no target testfeature/CDP/marker fallback.",
  ],
}
let stage = "admission",
  work,
  evidence,
  env,
  executable,
  activePid,
  psExe
async function hash(path) {
  const h = createHash("sha256")
  for await (const bytes of createReadStream(path)) h.update(bytes)
  return h.digest("hex")
}
async function absent(path) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error.code === "ENOENT") return true
    throw error
  }
}
async function proof(name, value) {
  await writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
}
async function wait(label, fn, timeout = 120_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await delay(400)
  }
  throw new Error(`Timeout: ${label}`)
}
function command(file, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    })
    let text = "",
      tooLarge = false
    child.stdout.on("data", (bytes) => {
      if (text.length + bytes.length > 1024 * 1024) tooLarge = true
      else text += bytes.toString("utf8")
    })
    child.stderr.resume() // Never expose OS/application logs or accessibility dumps.
    child.stdin.end(options.input ?? "")
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Owned native command timeout"))
    }, options.deadline ?? 60_000)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Owned native command unavailable"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      !tooLarge && (code === 0 || (code === 1 && options.nativeResponse))
        ? done({ text, pid: child.pid, exitCode: code })
        : reject(new Error("Owned native command failed"))
    })
  })
}
async function ps(script, extra = {}) {
  const response = await command(
    psExe,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`,
    ],
    { env: { ...env, ...extra } },
  )
  return JSON.parse(response.text.replace(/^\uFEFF/, ""))
}
function cleanEnvironment() {
  const keys = windows
    ? [
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "PUBLIC",
        "USERNAME",
        "USERDOMAIN",
        "COMPUTERNAME",
        "OS",
        "PROCESSOR_ARCHITECTURE",
      ]
    : [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
      ]
  const out = Object.fromEntries(
    keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  )
  out.PATH = windows
    ? [join(required("SystemRoot"), "System32"), required("SystemRoot")].join(";")
    : "/usr/bin:/bin"
  // Public runtime admission only, not runner/action credentials.
  for (const key of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_TEMP"])
    out[key] = required(key)
  if (!windows) {
    out.NO_AT_BRIDGE = "0"
    out.GTK_MODULES = "atk-bridge"
  }
  return out
}
async function processes() {
  if (windows)
    return ps(
      `$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'omp-desktop.exe' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;path=$_.ExecutablePath} }); ConvertTo-Json -InputObject $rows -Compress`,
    )
  const rows = []
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if ((await readFile(`/proc/${entry}/comm`, "utf8")).trim() === "omp-desktop")
        rows.push({ pid: Number(entry) })
    } catch {
      /* process exited */
    }
  }
  return rows
}
async function registrations() {
  return ps(
    `$rows=@(foreach($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){ if(Test-Path $root){ Get-ChildItem $root | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DisplayName -match '(?i)OMP[ -]?Desktop'){ [pscustomobject]@{name=$p.DisplayName;version=$p.DisplayVersion;location=$p.InstallLocation} } } } }); ConvertTo-Json -InputObject $rows -Compress`,
  )
}
async function pe(file, version) {
  const data = await ps(
    `$v=(Get-Item -LiteralPath $env:NATIVE_EXE).VersionInfo; [pscustomobject]@{product=$v.ProductName;fileVersion=('{0}.{1}.{2}' -f $v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart);productVersion=('{0}.{1}.{2}' -f $v.ProductMajorPart,$v.ProductMinorPart,$v.ProductBuildPart)} | ConvertTo-Json -Compress`,
    { NATIVE_EXE: file },
  )
  assert.equal(data.product, "OMP Desktop")
  assert.equal(data.fileVersion, version)
  assert.equal(data.productVersion, version)
  return data
}
async function files(root) {
  const paths = []
  for (const item of await readdir(root, { withFileTypes: true })) {
    assert(!item.isSymbolicLink(), "Owned installation contains redirected path")
    const path = join(root, item.name)
    if (item.isDirectory()) paths.push(...(await files(path)))
    else if (item.isFile()) paths.push(path)
  }
  return paths
}
async function install(release, directory, label) {
  assert.equal((await processes()).length, 0)
  assert.equal(await hash(release.windowsInstaller.path), release.windowsInstaller.sha256)
  const run = await command(release.windowsInstaller.path, ["/S", `/D=${directory}`], {
    windowsVerbatimArguments: true,
    deadline: 240_000,
  })
  const rows = await registrations()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, "OMP Desktop")
  assert.equal(rows[0].version, release.version)
  assert(same(rows[0].location.replace(/^"(.*)"$/, "$1"), directory))
  const paths = await files(directory)
  const matches = paths.filter((path) => basename(path).toLowerCase() === "omp-desktop.exe")
  assert.equal(matches.length, 1)
  const file = matches[0],
    metadata = await pe(file, release.version)
  result.installers.push({
    label,
    pid: run.pid,
    sha256: release.windowsInstaller.sha256,
    exitCode: 0,
    directory,
    metadata,
    registrations: rows,
  })
  assert.equal((await processes()).length, 0)
  return file
}
async function observeSdkInstaller(expectedSha256) {
  return wait(
    "actual SDK NSIS installer process and signed bytes",
    async () => {
      const rows = await ps(
        `$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:SDK_TEMP,[StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath -match '-0\\.9\\.13-updater-' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;path=$_.ExecutablePath} }); ConvertTo-Json -InputObject $rows -Compress`,
        { SDK_TEMP: env.TEMP },
      )
      for (const row of rows) {
        if (!inside(resolve(env.TEMP), resolve(row.path))) continue
        try {
          if ((await hash(row.path)) === expectedSha256)
            return { ...row, sha256: expectedSha256, observedAt: new Date().toISOString() }
        } catch {
          /* A different short-lived temp process exited. */
        }
      }
      return null
    },
    180_000,
  ).catch(() => null)
}
async function native(request, retry = false) {
  const q = { root: work, evidence, executable, ...request }
  result.lastNativeOperation = {
    operation: q.operation,
    name: q.name ?? null,
    kind: q.kind ?? null,
    expectedVersion: q.expectedVersion ?? null,
    requestedTexts: q.texts ?? [],
  }
  const invoke = async () => {
    try {
      const response = await command(
        required("PRODUCTION_NATIVE_PYTHON"),
        [join(harness, ".github/scripts/production-native-ui.py")],
        { input: JSON.stringify(q), deadline: 30_000, nativeResponse: true },
      )
      const value = JSON.parse(response.text)
      if (response.exitCode !== 0 || value.error) {
        result.lastNativeOperation.failure = { code: value.code, exception: value.exception }
        return null
      }
      delete result.lastNativeOperation.failure
      return value
    } catch {
      return null
    }
  }
  const value = retry ? await wait("owned native UI/observation", invoke) : await invoke()
  assert(value, "Native UI operation unavailable; no fallback")
  return value
}
const click = (name, kind = "button") => native({ operation: "click", pid: activePid, name, kind })
async function observe(texts, label, excludePids = [], theme, expectedVersion) {
  const request = {
    operation: "observe",
    pid: activePid ?? undefined,
    texts,
    excludePids,
    expectedVersion,
    tesseract: expectedVersion ? required("PRODUCTION_NATIVE_TESSERACT") : undefined,
  }
  const data = await native(request, true)
  activePid = data.pid
  // Capture only after successful assertions; screenshot failure is not a retry of a mutation.
  const surface = await native({
    ...request,
    pid: activePid,
    screenshot: join(evidence, `${label}.png`),
    theme,
  })
  if (theme) await proof(`${label}-theme.json`, surface)
  return data
}
async function start(label, version, excludePids = []) {
  assert.equal((await processes()).length, 0, "Surviving production process before start")
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    env,
    stdio: "ignore",
    windowsHide: false,
  })
  child.on("error", () => {})
  child.unref()
  const data = await observe([], label, excludePids, undefined, version)
  result.launches.push({
    label,
    ...data,
    launchedPid: child.pid,
    imageSha256: await hash(executable),
    version,
  })
  return data.pid
}
async function close() {
  const pid = activePid
  await native({ operation: "close", pid })
  await wait(
    "owned native graceful exit",
    async () => !(await processes()).some((p) => p.pid === pid),
    30_000,
  )
  assert.equal((await processes()).length, 0, "Unexpected remaining OMP process")
  activePid = null
}
function preferencesView(settings) {
  assert(
    !settings.providerEnv && (settings.providerEnvKeys ?? []).length === 0,
    "Credential-bearing settings forbidden",
  )
  const keys = [
    "ompExecutable",
    "sessionRoot",
    "language",
    "appFontFamily",
    "appFontSize",
    "terminalFontFamily",
    "terminalFontSize",
    "railMode",
    "recentWorkspaces",
    "lastWorkspace",
    "workspaceNames",
    "hiddenWorkspaces",
    "sessionTitlePins",
    "primaryProviderPins",
    "proxyProviders",
  ]
  return {
    ...Object.fromEntries(
      keys.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]),
    ),
    desktopTheme: settings.desktopTheme ?? "dark",
    workspaceNames: settings.workspaceNames ?? {},
    hiddenWorkspaces: settings.hiddenWorkspaces ?? [],
    sessionTitlePins: settings.sessionTitlePins ?? {},
    primaryProviderPins: settings.primaryProviderPins ?? [],
    proxyProviders: settings.proxyProviders ?? [],
  }
}
async function preferences(fixture, mutate) {
  await click("Settings")
  await native(
    { operation: "observe", pid: activePid, texts: ["Interface text scale", "General"] },
    true,
  )
  if (mutate) {
    await native({ operation: "select", pid: activePid, name: "Interface text scale", index: 6 }) // 22px => 138%
    await click("Behavior", "tab")
    await native({ operation: "observe", pid: activePid, texts: ["Terminal font size"] }, true)
    await native({ operation: "select", pid: activePid, name: "Terminal font size", index: 8 }) // stable12 and target13 use the same 8..32 options: 16px.
    await click("Save") // Exactly once. Unknown save outcome is failure, never repeated.
    await wait("durable native UI Save", async () => {
      const settings = JSON.parse(await readFile(fixture.settingsFile, "utf8"))
      return settings.appFontSize === 22 && settings.terminalFontSize === 16
    })
    await click("General", "tab")
  }
  await native(
    { operation: "value", pid: activePid, name: "Interface text scale", expected: "138%" },
    true,
  )
  await native(
    {
      operation: "value",
      pid: activePid,
      name: "OMP executable",
      kind: "edit",
      expected: fixture.noCli,
    },
    true,
  )
  await native(
    {
      operation: "value",
      pid: activePid,
      name: "Sessions folder",
      kind: "edit",
      expected: fixture.sessions,
      screenshot: join(evidence, `preferences-${result.launches.length}-general.png`),
    },
    true,
  )
  await click("Behavior", "tab")
  await native(
    {
      operation: "value",
      pid: activePid,
      name: "Terminal font size",
      expected: "16px",
      screenshot: join(evidence, `preferences-${result.launches.length}-terminal.png`),
    },
    true,
  )
  await click("Cancel")
}
async function state(fixture, version, label) {
  await observe(
    [basename(fixture.project), fixture.title],
    `${label}-workspace`,
    [],
    undefined,
    version,
  )
  await click("Open transcript")
  await observe([fixture.title, ...fixture.messages.map(({ text }) => text)], `${label}-transcript`)
  await native({ operation: "escape", pid: activePid })
  const settings = JSON.parse(await readFile(fixture.settingsFile, "utf8"))
  const selected = preferencesView(settings)
  assert.equal(selected.language, "en")
  assert.equal(selected.appFontSize, 22)
  assert.equal(selected.terminalFontSize, 16)
  assert(same(selected.sessionRoot, fixture.sessions))
  assert(same(selected.ompExecutable, fixture.noCli))
  assert(same(selected.lastWorkspace, fixture.project))
  assert.equal(await hash(fixture.session), fixture.sessionHash)
  assert.equal(await hash(fixture.projectFile), fixture.projectHash)
  assert.equal(
    settings.desktopUpdatePrereleases ?? false,
    version === "0.9.13" && process.env.PRODUCTION_NATIVE_MODE === "updater",
  )
  await proof(`${label}-state.json`, {
    pid: activePid,
    version,
    settings: selected,
    desktopUpdatePrereleases: settings.desktopUpdatePrereleases ?? false,
    settingsFile: fixture.settingsFile,
    settingsSha256: await hash(fixture.settingsFile),
    sessionSha256: fixture.sessionHash,
    workspaceSha256: fixture.projectHash,
    visibleSyntheticTranscript: fixture.messages,
    sessionId: fixture.id,
    sessionTitle: fixture.title,
    imageSha256: await hash(executable),
  })
  return selected
}
async function receipt() {
  const file = resolve(required("PRODUCTION_RECEIPT"))
  assert(same(file, join(evidence, "verified-production-assets.json")))
  const value = JSON.parse(await readFile(file, "utf8"))
  assert.equal(value.repository, "Omnividente/omp-desktop")
  assert.equal(value.base.version, "0.9.12")
  assert.equal(value.base.tag, "v0.9.12")
  assert.equal(value.base.commit, "dba7f41a77c4b957b45527a591cdfdb0be5f252f")
  assert.equal(value.base.tagObjectSha, "c6a574bfccad037bd66cf52b8c8294cdf598e477")
  assert.equal(value.base.releaseId, 438773398)
  assert.equal(value.target.version, "0.9.13")
  assert.equal(value.target.tag, "v0.9.13")
  assert.equal(value.target.commit, required("PRODUCTION_TARGET_SHA"))
  assert.equal(String(value.target.releaseId), required("PRODUCTION_TARGET_RELEASE_ID"))
  assert.equal(String(value.target.releaseRunId), required("PRODUCTION_TARGET_RUN_ID"))
  for (const release of [value.base, value.target]) {
    assert(/^[a-f0-9]{40}$/.test(release.tagObjectSha))
    for (const asset of release.assets) {
      assert.equal(basename(asset.name), asset.name)
      assert(/^[a-f0-9]{64}$/.test(asset.sha256))
      const path = join(release.assetsDir, asset.name)
      assert(same(path, await realpath(path)))
      assert.equal((await stat(path)).size, asset.bytes)
      assert.equal(await hash(path), asset.sha256)
    }
    for (const nativeAsset of [release.windowsInstaller, release.linuxAppImage]) {
      assert(same(dirname(nativeAsset.path), release.assetsDir))
      const asset = release.assets.find((item) => item.name === basename(nativeAsset.path))
      assert(asset)
      assert.equal(asset.sha256, nativeAsset.sha256)
    }
  }
  result.receiptSha256 = await hash(file)
  result.identities = {
    base: { commit: value.base.commit, releaseId: value.base.releaseId },
    target: {
      commit: value.target.commit,
      releaseId: value.target.releaseId,
      runId: value.target.releaseRunId,
    },
    harness: required("PRODUCTION_HARNESS_SHA"),
  }
  return value
}
async function fixture() {
  const home = windows ? required("USERPROFILE") : required("HOME")
  let config
  if (windows) {
    const folders = await ps(
      `[pscustomobject]@{roaming=[Environment]::GetFolderPath('ApplicationData');local=[Environment]::GetFolderPath('LocalApplicationData');home=[Environment]::GetFolderPath('UserProfile');interactive=[Environment]::UserInteractive;session=(Get-Process -Id $PID).SessionId} | ConvertTo-Json -Compress`,
    )
    assert(folders.interactive && folders.session > 0)
    assert(same(folders.roaming, required("APPDATA")))
    assert(same(folders.home, home))
    assert(await absent(join(folders.local, "com.ompdesk.desktop")))
    assert.equal((await registrations()).length, 0)
    config = join(folders.roaming, "com.ompdesk.desktop")
  } else {
    assert(
      !process.env.XDG_CONFIG_HOME || same(process.env.XDG_CONFIG_HOME, join(home, ".config")),
      "Refusing nondefault native profile",
    )
    assert(await absent(join(home, ".local/share/com.ompdesk.desktop")))
    config = join(home, ".config/com.ompdesk.desktop")
  }
  assert(await absent(join(home, ".omp")))
  assert(await absent(config))
  assert.equal((await processes()).length, 0)
  const f = {
    project: join(work, "Production synthetic workspace"),
    sessions: join(work, "synthetic-sessions"),
    noCli: join(
      work,
      windows ? "intentionally-nonexistent-omp.exe" : "intentionally-nonexistent-omp",
    ),
    settingsFile: join(config, "settings.json"),
    id: "production-native-synthetic",
    title: "Production native state survives",
    messages: [
      { role: "user", text: "Synthetic user state before production replacement." },
      {
        role: "assistant",
        text: "Synthetic answer preserved by the actual production application.",
      },
    ],
  }
  await mkdir(f.project)
  await mkdir(f.sessions)
  await mkdir(config, { recursive: true })
  f.projectFile = join(f.project, "synthetic-workspace.txt")
  await writeFile(f.projectFile, "Production native acceptance synthetic workspace.\n", {
    flag: "wx",
  })
  f.projectHash = await hash(f.projectFile)
  f.session = join(f.sessions, "production-state.jsonl")
  const timestamp = "2026-11-09T00:00:00.000Z"
  const rows = [
    { type: "session", version: 3, id: f.id, timestamp, cwd: f.project, title: f.title },
    ...f.messages.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index ? "message-0" : null,
      timestamp,
      message: { role: message.role, content: [{ type: "text", text: message.text }] },
    })),
  ]
  await writeFile(f.session, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, {
    flag: "wx",
  })
  f.sessionHash = await hash(f.session)
  await writeFile(
    f.settingsFile,
    `${JSON.stringify({ ompExecutable: f.noCli, sessionRoot: f.sessions, language: "en", appFontSize: 20, terminalFontSize: 14, recentWorkspaces: [f.project], lastWorkspace: f.project, railMode: "expanded" })}\n`,
    { flag: "wx" },
  )
  return f
}
async function replaceImage(source, expectedHash) {
  assert.equal((await processes()).length, 0)
  assert.equal(await hash(source), expectedHash)
  await copyFile(source, executable)
  await chmod(executable, 0o755)
  assert.equal(await hash(executable), expectedHash)
}
const runtimeSource = "751e753860585ada032b8a62cc65f5ba0fd124ff"
const runtimeVersion = "18.20.0"
let runtimePath
const settingsPath = () =>
  join(
    windows ? required("APPDATA") : join(required("HOME"), ".config"),
    "com.ompdesk.desktop/settings.json",
  )
async function durableSettings(predicate, label) {
  return wait(label, async () => {
    if (await absent(settingsPath())) return null
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"))
    assert(!settings.providerEnv && (settings.providerEnvKeys ?? []).length === 0)
    return predicate(settings) ? settings : null
  })
}
async function terminalObservation(label, patterns) {
  const observation = await native(
    {
      operation: "terminal-ocr",
      pid: activePid,
      label,
      patterns,
      tesseract: required("PRODUCTION_NATIVE_TESSERACT"),
    },
    true,
  )
  await native({
    operation: "observe",
    pid: activePid,
    texts: [],
    screenshot: join(evidence, `${label}.png`),
  })
  await proof(`${label}.json`, observation)
}
async function installRuntime() {
  stage = "new-user-official-runtime-install"
  const scriptName = windows ? "install.ps1" : "install.sh"
  const url = `https://raw.githubusercontent.com/can1357/oh-my-pi/${runtimeSource}/scripts/${scriptName}`
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash("sha256").update(bytes).digest("hex")
  assert.equal(
    digest,
    windows
      ? "6436e20b1de503455a6248471dea173a21969ab116d9ce4bc40a3263a52594f8"
      : "9d8aea7105ab30b46f048c3ba9216ae9f92375491b883e510059069dbf968a5f",
  )
  const script = join(work, `upstream-${scriptName}`)
  await writeFile(script, bytes, { flag: "wx" })
  // Only the same credential-free allowlisted environment as the production app.
  if (windows)
    await command(
      psExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Binary",
        "-Ref",
        `v${runtimeVersion}`,
      ],
      { deadline: 900_000 },
    )
  else
    await command("/bin/sh", [script, "--binary", "--ref", `v${runtimeVersion}`], {
      deadline: 900_000,
    })
  assert(
    /\b18\.20\.0\b/.test((await command(runtimePath, ["--version"])).text),
    "Actual installed upstream CLI version differs",
  )
  await proof("new-user-runtime-install.json", {
    method: "Official separate upstream binary installer; not a Desktop install_omp command",
    source: runtimeSource,
    scriptUrl: url,
    scriptSha256: digest,
    version: runtimeVersion,
    path: runtimePath,
    sha256: await hash(runtimePath),
    credentialsSupplied: false,
    inferenceRequested: false,
  })
}
async function firstUserJourney() {
  stage = "new-user-fresh-native-profile"
  const home = windows ? required("USERPROFILE") : required("HOME")
  const config = dirname(settingsPath())
  const data = windows
    ? join(required("LOCALAPPDATA"), "com.ompdesk.desktop")
    : join(home, ".local/share/com.ompdesk.desktop")
  runtimePath = windows
    ? join(required("LOCALAPPDATA"), "omp/omp.exe")
    : join(home, ".local/bin/omp")
  for (const path of [config, data, join(home, ".omp"), runtimePath])
    assert(await absent(path), "Existing native/runtime profile; refusing first-user journey")
  const project = join(work, "First real OMP project")
  await mkdir(project)
  const projectFile = join(project, "README.txt")
  await writeFile(projectFile, "Disposable hosted VM project; no credentials or inference.\n", {
    flag: "wx",
  })
  const projectHash = await hash(projectFile)
  const firstPid = await start("new-user-FIRST-candidate-launch", "0.9.13")
  await observe(["Откройте папку проекта", "OMP недоступен"], "new-user-first-screen-ru")
  await click("Настройки")
  await native({ operation: "select", pid: activePid, name: "Язык интерфейса", index: 1 })
  await click("Save")
  await durableSettings((s) => s.language === "en", "new-user English Save")
  await observe(
    ["OMP unavailable", "OMP probe failures", "Set the executable path below"],
    "new-user-actionable-discovery-error",
  )
  await native({
    operation: "value",
    pid: activePid,
    name: "OMP executable",
    kind: "edit",
    expected: "",
  })
  await observe(["Leave empty to auto-detect"], "new-user-discovery-recovery-guidance")
  await click("Cancel")
  const hint = "OMP Desktop will launch the agent in the selected folder"
  await observe(["Open project folder", hint], "new-user-dark-first-screen-hint", [], "dark")
  await click("Settings")
  await native({ operation: "select", pid: activePid, name: "Interface theme", index: 1 })
  await click("Save")
  await durableSettings((s) => s.desktopTheme === "light", "new-user light theme Save")
  await click("Cancel")
  await observe(["Open project folder", hint], "new-user-light-first-screen-hint", [], "light")
  await click("Settings")
  await native({ operation: "select", pid: activePid, name: "Interface language", index: 2 })
  await click("保存")
  await durableSettings((s) => s.language === "zh", "Chinese native Save")
  await click("取消")
  await close()
  await start("new-user-Chinese-native-restart", "0.9.13", [firstPid])
  await observe(
    ["打开项目文件夹", "OMP Desktop 将在所选文件夹中启动智能体"],
    "new-user-Chinese-persisted",
  )
  await click("设置")
  await native({ operation: "select", pid: activePid, name: "界面语言", index: 1 })
  await native({ operation: "select", pid: activePid, name: "Interface theme", index: 0 })
  await click("Save")
  await durableSettings(
    (s) => s.language === "en" && s.desktopTheme === "dark",
    "restore native journey language",
  )
  await click("Cancel")
  await close()
  await installRuntime() // After the installed candidate's genuine FIRST launch.
  stage = "new-user-native-runtime-discovery"
  await start("new-user-runtime-discovered", "0.9.13")
  await click("Settings")
  await observe(["OMP connected", runtimeVersion], "new-user-real-runtime-discovery")
  await native({
    operation: "value",
    pid: activePid,
    name: "OMP executable",
    kind: "edit",
    expected: "",
  })
  await click("Cancel")
  await click("Open folder")
  await native({ operation: "folder", pid: activePid, path: project })
  await observe([basename(project), "New session"], "new-user-selected-project")
  await durableSettings((s) => same(s.lastWorkspace, project), "native project selection persisted")
  stage = "new-user-first-real-pty"
  await click("New session")
  const runtime = await native(
    { operation: "runtime-process", pid: activePid, runtime: runtimePath, project },
    true,
  )
  await proof("new-user-real-pty.json", runtime)
  // A fresh v18.20.0 profile enters its six-step setup wizard, not the prompt editor.
  // Observe the real first-session boundary without logging in or submitting text.
  await terminalObservation("new-user-real-runtime-first-setup", [
    "Setup\\s+step\\s+1\\s+of\\s+6[\\s\\S]*Sign\\s+in\\s+to\\s+your\\s+providers",
  ])
  assert.equal(await hash(projectFile), projectHash)
  await close()
  await proof("new-user-journey.json", {
    status: "PASS",
    candidate: "0.9.13",
    runtime: runtimeVersion,
    firstInstalledCandidatePid: firstPid,
    projectSha256: projectHash,
    realPty: runtime.runtime,
    externalOfficialInstall: true,
    sessionBoundary: "Actual first-run provider setup; no login or prompt submission",
    inferenceRequested: false,
    modelResponseClaimed: false,
    ChineseSaveAndNativeRestart: true,
    darkAndLightFirstScreenHint: true,
  })
  // Archive only profiles proven absent before this journey; no exports or real data.
  // State-fixtures below are separate and can never stand in for onboarding.
  for (const [path, name] of [
    [config, "desktop-config"],
    [data, "desktop-data"],
    [join(home, ".omp"), "runtime-profile"],
  ]) {
    if (!(await absent(path))) await rename(path, join(work, `new-user-private-${name}`))
  }
}

async function completedAnswerJourney(fixture) {
  stage = "synthetic-answer-real-runtime-pty"
  await start("target-synthetic-answer-real-pty", "0.9.13")
  await click("Settings")
  await native({ operation: "edit", pid: activePid, name: "OMP executable", text: runtimePath })
  await click("Save")
  await durableSettings(
    (s) => same(s.ompExecutable, runtimePath),
    "real runtime chosen for synthetic answer fixture",
  )
  await click("Cancel")
  await click("Resume last")
  const request = {
    operation: "runtime-process",
    pid: activePid,
    runtime: runtimePath,
    project: fixture.project,
  }
  const before = await native(request, true)
  const answer = fixture.messages.find((message) => message.role === "assistant").text
  await native(
    { operation: "observe", pid: activePid, texts: ["Show answer"], absentTexts: [answer] },
    true,
  )
  await native({ operation: "terminal-keys", pid: activePid, keys: "escape" })
  await native({ operation: "terminal-keys", pid: activePid, keys: "clear", focus: false })
  await native({ operation: "terminal-keys", pid: activePid, keys: "draft", focus: false })
  await terminalObservation("answer-default-collapsed-live-console", ["native\\s*focus\\s*draft"])
  await click("Show answer")
  await observe(["Collapse answer", answer], "answer-explicit-expanded-synthetic")
  await terminalObservation("answer-expanded-preserves-live-console-draft", [
    "native\\s*focus\\s*draft",
  ])
  await click("Collapse answer")
  await native(
    { operation: "observe", pid: activePid, texts: ["Show answer"], absentTexts: [answer] },
    true,
  )
  await terminalObservation("answer-recollapsed-preserves-live-console-draft", [
    "native\\s*focus\\s*draft",
  ])
  // Explicit console focus; do not demand rejected expand/collapse auto-focus or Escape hooks.
  await native({ operation: "terminal-keys", pid: activePid, keys: "escape" })
  await native({ operation: "terminal-keys", pid: activePid, keys: "draft", focus: false })
  await terminalObservation("answer-native-escape-keeps-console-input", [
    "native\\s*focus\\s*draft",
  ])
  const after = await native(request)
  assert.equal(after.runtime.pid, before.runtime.pid, "Answer controls replaced the actual runtime")
  assert.equal(after.runtime.sha256, before.runtime.sha256)
  await proof("minimal-251-native-synthetic-answer.json", {
    status: "PASS",
    defaultCollapsed: true,
    explicitExpandCollapse: true,
    realRuntime: after.runtime,
    syntheticAnswer: true,
    modelResponseClaimed: false,
    consoleAndDraftVisibleAcrossToggle: true,
    rejectedEscapeOrAutoFocusHooksRequired: false,
    boundary:
      "Separate fixture after strict production replacement/state checks; runtime resume may append session metadata",
  })
  await close()
}

async function main() {
  assert(["win32", "linux"].includes(process.platform))
  assert.equal(process.env.GITHUB_ACTIONS, "true")
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted")
  assert.equal(process.env.GITHUB_SHA, required("PRODUCTION_HARNESS_SHA"))
  assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA))
  const mode = required("PRODUCTION_NATIVE_MODE")
  assert(["normal", "updater"].includes(mode))
  assert(!windows || mode === "updater")
  result.gate =
    mode === "updater"
      ? `production-trust-new-broker-${process.platform}`
      : "production-normal-appimage-replacement-state"
  const temp = await realpath(required("RUNNER_TEMP"))
  work = resolve(required("PRODUCTION_SMOKE_WORK_DIR"))
  evidence = resolve(required("PRODUCTION_EVIDENCE_DIR"))
  assert(
    inside(temp, work) &&
      inside(temp, evidence) &&
      !inside(work, evidence) &&
      !inside(evidence, work) &&
      !same(work, evidence),
  )
  assert(await absent(work))
  assert(same(await realpath(evidence), evidence))
  await mkdir(work)
  assert(same(await realpath(work), work))
  env = cleanEnvironment()
  if (windows) psExe = join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
  if (windows) {
    const sdkTemp = join(work, "sdk-temp")
    await mkdir(sdkTemp)
    env.TEMP = sdkTemp
    env.TMP = sdkTemp
  }
  stage = "receipt"
  const assets = await receipt()
  let targetExeHash
  if (windows) {
    // Independent exact NSIS byte oracle also runs the genuine first-user journey.
    // Uninstall it before the shipped stable12 baseline; never copy reference bytes into SDK install.
    const referenceDir = join(work, "target-reference")
    assert.equal((await registrations()).length, 0, "Existing native installation")
    const referenceExe = await install(assets.target, referenceDir, "target-reference-only")
    targetExeHash = await hash(referenceExe)
    result.referenceTarget = {
      executable: referenceExe,
      sha256: targetExeHash,
      installerSha256: assets.target.windowsInstaller.sha256,
    }
    executable = referenceExe
    await firstUserJourney()
    const uninstallers = (await files(referenceDir)).filter((path) =>
      /^uninstall.*\.exe$/i.test(basename(path)),
    )
    assert.equal(uninstallers.length, 1)
    await command(uninstallers[0], ["/S"], { deadline: 120_000 })
    await wait(
      "reference uninstall registration removed",
      async () => (await registrations()).length === 0,
    )
  } else {
    executable = join(work, "OMP.Desktop.AppImage")
    await replaceImage(assets.target.linuxAppImage.path, assets.target.linuxAppImage.sha256)
    await firstUserJourney()
  }
  stage = "separate-synthetic-state-fixture"
  const f = await fixture()
  if (windows)
    executable = await install(assets.base, join(work, "installed"), "shipped-stable12-baseline")
  else await replaceImage(assets.base.linuxAppImage.path, assets.base.linuxAppImage.sha256)
  stage = "baseline-native-ui-save"
  const baselinePid = await start("base-initial", "0.9.12")
  await preferences(f, true)
  const expected = await state(f, "0.9.12", "base-initial")
  await close()
  assert.deepEqual(preferencesView(JSON.parse(await readFile(f.settingsFile, "utf8"))), expected)
  if (mode === "normal") {
    stage = "normal-appimage-replacement"
    await replaceImage(assets.target.linuxAppImage.path, assets.target.linuxAppImage.sha256)
    result.normalReplacement = {
      method: "explicit normal AppImage working-copy replacement, NOT SDK",
      beforeSha256: assets.base.linuxAppImage.sha256,
      afterSha256: assets.target.linuxAppImage.sha256,
    }
    await start("target-replaced", "0.9.13", [baselinePid])
  } else {
    stage = "production-probe-admission"
    const sourceProof = JSON.parse(
      await readFile(join(evidence, "production-probe-source.json"), "utf8"),
    )
    assert.equal(sourceProof.targetSource, required("PRODUCTION_TARGET_SHA"))
    assert.equal(sourceProof.probeSource, required("PRODUCTION_HARNESS_SHA"))
    assert.equal(sourceProof.trust, "unchanged-production")
    const probe = resolve(required("PRODUCTION_PROBE_PATH"))
    assert(!same(probe, executable))
    assert(
      inside(harness, probe) && same(await realpath(probe), probe),
      "Diagnostic bytes must come from the pinned build output",
    )
    const probeHash = await hash(probe)
    await copyFile(probe, executable)
    if (!windows) await chmod(executable, 0o755)
    assert.equal(await hash(executable), probeHash)
    if (windows) await pe(executable, "0.9.12")
    const marker = join(work, "production-probe-events.jsonl")
    const guard = {
      targetSha: required("PRODUCTION_TARGET_SHA"),
      harnessSha: required("PRODUCTION_HARNESS_SHA"),
      releaseId: required("PRODUCTION_TARGET_RELEASE_ID"),
      targetVersion: "0.9.13",
      probeVersion: "0.9.12",
      settingsFile: f.settingsFile,
    }
    await writeFile(join(work, "production-probe-guard.json"), `${JSON.stringify(guard)}\n`, {
      flag: "wx",
    })
    result.probe = {
      ...guard,
      inputSha256: probeHash,
      installedSha256: await hash(executable),
      path: executable,
      sourceProofSha256: await hash(join(evidence, "production-probe-source.json")),
    }
    // After spawn there are NO controller writes to the installation. First
    // target launch must be NSIS/SDK or app.restart(), never a controller launch.
    const child = spawn(
      executable,
      ["--updater-e2e-mode=production", `--updater-e2e-marker=${marker}`],
      {
        env: {
          ...env,
          OMP_DESKTOP_UPDATER_E2E_MODE: "production",
          OMP_DESKTOP_UPDATER_E2E_MARKER: marker,
        },
        cwd: dirname(executable),
        stdio: "ignore",
        windowsHide: false,
      },
    )
    child.on("error", () => {})
    child.unref()
    const sdkInstaller = windows ? observeSdkInstaller(assets.target.windowsInstaller.sha256) : null
    const events = async () => {
      if (await absent(marker)) return []
      const text = await readFile(marker, "utf8")
      // A writer may be between write/flush while polled. Consume only complete
      // JSONL rows; terminal events are required separately, never inferred.
      return text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean)
        .map((row) => JSON.parse(row))
    }
    const rows = await wait("actual broker candidate/install request", async () => {
      const rows = await events()
      assert(!rows.some((row) => row.event === "error"), "Production probe reported failure")
      return rows.some((row) => row.event === "production-install-requested") ? rows : null
    })
    const started = rows.find((row) => row.event === "production-started")
    const stableOnly = rows.find((row) => row.event === "production-stable-only")
    assert(stableOnly, "Actual stable-only broker discovery event missing")
    assert.equal(stableOnly.detail.includePrereleases, false)
    assert.equal(stableOnly.detail.available, false)
    assert.equal(stableOnly.detail.policyState, "ready")
    const candidate = rows.find((row) => row.event === "production-candidate")
    assert(started && candidate)
    assert(
      rows.indexOf(stableOnly) < rows.indexOf(candidate),
      "Opt-in bypassed stable-only discovery",
    )
    assert.equal(started.version, "0.9.12")
    assert.notEqual(started.pid, baselinePid, "Diagnostic probe reused the baseline PID")
    assert.equal(started.detail.targetSource, guard.targetSha)
    assert.equal(started.detail.probeSource, guard.harnessSha)
    assert.equal(started.detail.trust, "production")
    assert.equal(
      started.detail.metadataSource,
      "https://api.github.com/repos/Omnividente/omp-desktop/releases",
    )
    assert.equal(candidate.detail.version, "0.9.13")
    assert.equal(candidate.detail.releaseId, guard.releaseId)
    assert.equal(
      candidate.detail.releaseUrl,
      "https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.13",
    )
    assert.equal(candidate.detail.prerelease, true)
    result.probe.pid = started.pid
    result.probe.launcherPid = child.pid
    stage = "first-sdk-target-native-ui"
    const first = await observe(
      [basename(f.project), f.title],
      "sdk-first-target-native",
      [baselinePid, started.pid],
      undefined,
      "0.9.13",
    )
    assert(
      !(await processes()).some((row) => row.pid === started.pid),
      "Probe process survived target relaunch",
    )
    assert.equal(
      await hash(executable),
      windows ? targetExeHash : assets.target.linuxAppImage.sha256,
      "SDK installed bytes differ from verified production target",
    )
    if (windows) {
      result.targetPe = await pe(executable, "0.9.13")
      const registrationsAfter = await registrations()
      assert.equal(registrationsAfter.length, 1)
      assert.equal(registrationsAfter[0].version, "0.9.13")
      result.targetRegistrations = registrationsAfter
    }
    if (windows) {
      result.sdkInstaller = await sdkInstaller
      assert(result.sdkInstaller, "Actual production SDK installer PID/hash was not observed")
      await proof("production-sdk-installer.json", result.sdkInstaller)
    }
    result.launches.push({
      label: "FIRST-SDK-RELAUNCH",
      ...first,
      version: "0.9.13",
      imageSha256: await hash(executable),
      controllerLaunch: false,
    })
    // Only diagnostic events are copied after a strict allowlist; TARGET has no marker.
    const allowed = new Set([
      "production-started",
      "production-stable-only",
      "production-candidate",
      "production-install-requested",
      "production-installed",
    ])
    const finalEvents = await events()
    assert(finalEvents.every((row) => allowed.has(row.event)))
    if (!windows) assert(finalEvents.some((row) => row.event === "production-installed"))
    await proof("production-broker-events.json", finalEvents)
    assert.equal(JSON.parse(await readFile(f.settingsFile, "utf8")).desktopUpdatePrereleases, true)
  }
  stage = "target-native-state"
  const firstPid = activePid
  assert.deepEqual(await state(f, "0.9.13", "target-first"), expected)
  await preferences(f, false)
  await close()
  stage = "target-normal-restart"
  await start("target-restarted", "0.9.13", [baselinePid, firstPid])
  assert.deepEqual(await state(f, "0.9.13", "target-restarted"), expected)
  await preferences(f, false)
  await close()
  assert.equal(await hash(executable), windows ? targetExeHash : assets.target.linuxAppImage.sha256)
  assert.equal(await hash(f.session), f.sessionHash)
  assert.equal(await hash(f.projectFile), f.projectHash)
  assert.deepEqual(preferencesView(JSON.parse(await readFile(f.settingsFile, "utf8"))), expected)
  await proof("production-final-state.json", {
    settingsSha256: await hash(f.settingsFile),
    settings: expected,
    originalSessionSha256: f.sessionHash,
    originalWorkspaceSha256: f.projectHash,
    installedSha256: await hash(executable),
    desktopUpdatePrereleases:
      JSON.parse(await readFile(f.settingsFile, "utf8")).desktopUpdatePrereleases ?? false,
  })
  await completedAnswerJourney(f)
  assert.equal(await hash(resolve(required("PRODUCTION_RECEIPT"))), result.receiptSha256)
  for (const release of [assets.base, assets.target])
    for (const asset of release.assets)
      assert.equal(await hash(join(release.assetsDir, asset.name)), asset.sha256)
  result.status = "PASS"
  stage = "complete"
}
try {
  await main()
} catch {
  // Assertion payloads may contain settings. Never upload stacks/native stderr.
  result.failure = {
    stage,
    reason:
      "Production native contract failed; inspect lastNativeOperation and the last bounded screenshot/proof, never retry a Save/install blindly",
    lastNativeOperation: result.lastNativeOperation ?? null,
    diagnostic:
      "Fresh VM only: check official runtime install/probe, owned window visibility, native chooser and first-session setup OCR. No provider key or model request is required.",
  }
  process.exitCode = 1
  if (work && evidence && executable && env) {
    const failedOperation = result.lastNativeOperation
    await native({
      operation: "observe",
      pid: activePid ?? undefined,
      texts: [],
      screenshot: join(evidence, "production-native-failure.png"),
    }).catch(() => {})
    result.lastNativeOperation = failedOperation
  }
} finally {
  // No broad kill or profile cleanup. The exclusively owned fresh VM is disposed.
  result.stage = stage
  if (evidence)
    await proof("production-native-result.json", result).catch(() => {
      process.exitCode = 1
    })
  console.log(`${result.status}: ${result.gate ?? "production-native"}; stage=${stage}`)
  // Owned GUI processes or observer timers must not hold a failed gate after evidence is saved.
  if (result.status !== "PASS") process.exit(Number(process.exitCode) || 1)
}

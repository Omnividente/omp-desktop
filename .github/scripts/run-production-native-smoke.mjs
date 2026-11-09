// Production Linux normal AppImage replacement OR separate Windows/Linux
// production-trust broker/SDK update. Every target is an unmodified release asset.
// Native UI uses OS accessibility and native-pixel version OCR, including FIRST SDK relaunch.
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
    "Fresh hosted VM synthetic data only; no provider/CLI inference or credentials.",
    "Shipped 0.9.10 latest-only discovery of a non-latest candidate is NOT proven.",
    "Production broker proof is a new-client diagnostic version floor, not a shipped-old-client discovery proof.",
    "Native accessibility/window unavailability fails closed; no target testfeature/CDP/marker fallback.",
  ],
}
let stage = "admission",
  work,
  evidence,
  env,
  executable,
  activePid,
  sdkObserver,
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
      const acceptedExitCodes = options.acceptExitCodes ?? [0]
      acceptedExitCodes.includes(code) && !tooLarge
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
  const temp = env.TEMP
  // Arm the kernel-backed start subscription before PROBE can launch NSIS.
  // Repeated PowerShell/CIM snapshots can miss the short-lived installer.
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$subscription = Register-CimIndicationEvent -Namespace root/cimv2 -ClassName Win32_ProcessStartTrace -SourceIdentifier OmpProductionSdk
try {
  [Console]::WriteLine('READY')
  $end = [DateTime]::UtcNow.AddSeconds(180)
  $found = $null
  $root = $env:SDK_TEMP.TrimEnd('\') + '\'
  while ([DateTime]::UtcNow -lt $end) {
    $notice = Wait-Event -SourceIdentifier OmpProductionSdk -Timeout 1 | Select-Object -First 1
    if ($null -eq $notice) { continue }
    $started = $notice.SourceEventArgs.NewEvent
    Remove-Event -EventIdentifier $notice.EventIdentifier
    $image = (Get-CimInstance Win32_Process -Filter "ProcessId = $($started.ProcessID)" -ErrorAction SilentlyContinue).ExecutablePath
    if (-not $image -or -not $image.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $image -notmatch '-0\.9\.12-updater-') { continue }
    try { $digest = (Get-FileHash -LiteralPath $image -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { continue }
    if ($digest -ne $env:SDK_SHA256) { continue }
    $found = [pscustomobject]@{pid=[int]$started.ProcessID;parentPid=[int]$started.ParentProcessID;path=$image;sha256=$digest;observedAt=[DateTime]::UtcNow.ToString('o')}
    break
  }
  ConvertTo-Json -InputObject $found -Compress
} finally {
  Unregister-Event -SourceIdentifier OmpProductionSdk
}`
  let markReady, finish
  const ready = new Promise((done) => {
    markReady = done
  })
  const observed = new Promise((done) => {
    finish = done
  })
  const child = spawn(psExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...env, SDK_TEMP: temp, SDK_SHA256: expectedSha256 },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  })
  child.unref()
  const stop = () => {
    child.kill()
  }
  const startup = setTimeout(() => {
    markReady(false)
    stop()
  }, 15_000)
  const deadline = setTimeout(stop, 190_000)
  let text = "",
    armed = false,
    tooLarge = false
  child.stdout.on("data", (bytes) => {
    if (text.length + bytes.length > 16 * 1024) {
      tooLarge = true
      stop()
      return
    }
    text += bytes.toString("utf8")
    const signal = !armed && /^READY\r?\n/.exec(text)
    if (signal) {
      text = text.slice(signal[0].length)
      armed = true
      clearTimeout(startup)
      markReady(true)
    }
  })
  child.once("error", () => {
    markReady(false)
    finish(null)
  })
  child.once("close", (code) => {
    markReady(false)
    try {
      const row = code === 0 && armed && !tooLarge ? JSON.parse(text) : null
      finish(
        row &&
          Number.isSafeInteger(row.pid) &&
          row.pid > 0 &&
          Number.isSafeInteger(row.parentPid) &&
          inside(temp, resolve(row.path)) &&
          row.sha256 === expectedSha256
          ? {
              pid: row.pid,
              parentPid: row.parentPid,
              path: row.path,
              sha256: row.sha256,
              observedAt: row.observedAt,
              method: "Win32_ProcessStartTrace",
            }
          : null,
      )
    } catch {
      finish(null)
    }
  })
  const observation = observed.finally(() => {
    clearTimeout(startup)
    clearTimeout(deadline)
  })
  assert(await ready, "Actual SDK process-start observer unavailable before PROBE")
  return { result: observation, stop }
}
async function native(request, retry = false) {
  const q = { root: work, evidence, executable, ...request }
  result.lastNativeOperation = {
    operation: q.operation,
    name: q.name ?? null,
    kind: q.kind ?? null,
  }
  const invoke = async () => {
    try {
      const response = await command(
        required("PRODUCTION_NATIVE_PYTHON"),
        [join(harness, ".github/scripts/production-native-ui.py")],
        {
          input: JSON.stringify(q),
          deadline: 30_000,
          acceptExitCodes: [0, 1],
        },
      )
      const value = JSON.parse(response.text)
      if (response.exitCode !== 0 || value.error) {
        // Only fixed phase/class identifiers, never native exception text or a tree.
        result.lastNativeFailure = {
          operation: q.operation,
          phase: /^[a-z-]{1,64}$/.test(value.phase ?? "") ? value.phase : "unclassified",
          exception: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.exception ?? "")
            ? value.exception
            : "OtherError",
          counts: Object.fromEntries(
            [
              "ownedWindows",
              "accessibilityApplications",
              "ownedAccessibilityApplications",
              "ownedAccessibleFrames",
              "requestedTexts",
              "visibleNodes",
              "matchedTexts",
              "selectionMenus",
            ]
              .filter((key) => Number.isSafeInteger(value.counts?.[key]))
              .map((key) => [key, value.counts[key]]),
          ),
        }
        return null
      }
      delete result.lastNativeFailure
      return value
    } catch {
      result.lastNativeFailure = {
        operation: q.operation,
        phase: "observer-command",
        exception: "CommandFailure",
      }
      return null
    }
  }
  const value = retry ? await wait("owned native UI/observation", invoke) : await invoke()
  assert(value, "Native UI operation unavailable; no fallback")
  return value
}
const click = (name, kind = "button") => native({ operation: "click", pid: activePid, name, kind })
async function observe(texts, label, { version, excludePids = [] } = {}) {
  const request = { operation: "observe", pid: activePid ?? undefined, texts, excludePids }
  if (version !== undefined) {
    request.version = version
    // English version-button aria-label verified in both v0.9.10 and TARGET sources.
    request.versionControlName = "Check for OMP Desktop updates"
    request.ocrExecutable = required("PRODUCTION_NATIVE_TESSERACT")
    assert(isAbsolute(request.ocrExecutable), "Native OCR executable must be an absolute path")
  }
  const data = await native(request, true)
  if (version !== undefined) {
    assert.equal(data.observedVersion, version)
    assert.equal(data.versionMethod, "native-pixel-ocr")
  }
  activePid = data.pid
  // Capture only after successful assertions; screenshot failure is not a retry of a mutation.
  const captured = await native({
    ...request,
    pid: activePid,
    screenshot: join(evidence, `${label}.png`),
  })
  if (version !== undefined) {
    assert.equal(captured.observedVersion, version)
    assert.equal(captured.versionMethod, "native-pixel-ocr")
  }
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
  const data = await observe([], label, { version, excludePids })
  result.launches.push({
    label,
    ...data,
    launchedPid: child.pid,
    imageSha256: await hash(executable),
    expectedVersion: version,
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
  await native({ operation: "observe", pid: activePid, texts: ["General"] }, true)
  if (mutate) {
    await native({ operation: "select", pid: activePid, name: "Interface text scale", index: 6 }) // 22px => 138%
    await click("Behavior", "tab")
    await native({ operation: "select", pid: activePid, name: "Terminal font size", index: 6 }) // Immutable 0.9.10 options: 16px, not the newer 8..32 list.
    await native({ operation: "observe", pid: activePid, texts: ["Terminal font size"] }, true)
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
    { operation: "observe", pid: activePid, texts: ["Interface text scale", "General"] },
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
  const workspace = await observe(
    [basename(fixture.project), fixture.title],
    `${label}-workspace`,
    { version },
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
  if (version === "0.9.12")
    assert.equal(
      settings.desktopUpdatePrereleases ?? false,
      process.env.PRODUCTION_NATIVE_MODE === "updater",
    )
  await proof(`${label}-state.json`, {
    pid: activePid,
    expectedVersion: version,
    observedVersion: workspace.observedVersion,
    versionMethod: workspace.versionMethod,
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
  assert.equal(value.base.version, "0.9.10")
  assert.equal(value.base.tag, "v0.9.10")
  assert.equal(value.base.commit, "73e661504b3d3d0a4b382e3289b02355b7400699")
  assert.equal(value.base.tagObjectSha, "b901b14eaf5f13c23e33d9ba84dd31b62d02a540")
  assert.equal(value.base.releaseId, 413772482)
  assert.equal(value.target.version, "0.9.12")
  assert.equal(value.target.tag, "v0.9.12")
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
  stage = "fresh-profile"
  const f = await fixture()
  let targetExeHash
  if (windows) {
    // Independent byte oracle from the exact immutable NSIS, never launched.
    // It is uninstalled before establishing the baseline. No reference bytes are
    // copied into the updater's installation at any point.
    const referenceDir = join(work, "target-reference")
    const referenceExe = await install(assets.target, referenceDir, "target-reference-only")
    targetExeHash = await hash(referenceExe)
    result.referenceTarget = {
      executable: referenceExe,
      sha256: targetExeHash,
      installerSha256: assets.target.windowsInstaller.sha256,
    }
    const uninstallers = (await files(referenceDir)).filter((path) =>
      /^uninstall.*\.exe$/i.test(basename(path)),
    )
    assert.equal(uninstallers.length, 1)
    await command(uninstallers[0], ["/S"], { deadline: 120_000 })
    await wait(
      "reference uninstall registration removed",
      async () => (await registrations()).length === 0,
    )
    executable = await install(assets.base, join(work, "installed"), "baseline")
  } else {
    executable = join(work, "OMP.Desktop.AppImage")
    await replaceImage(assets.base.linuxAppImage.path, assets.base.linuxAppImage.sha256)
  }
  stage = "baseline-native-ui-save"
  const baselinePid = await start("base-initial", "0.9.10")
  await preferences(f, true)
  const expected = await state(f, "0.9.10", "base-initial")
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
    await start("target-replaced", "0.9.12", [baselinePid])
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
    if (windows) await pe(executable, "0.9.11")
    const marker = join(work, "production-probe-events.jsonl")
    const guard = {
      targetSha: required("PRODUCTION_TARGET_SHA"),
      harnessSha: required("PRODUCTION_HARNESS_SHA"),
      releaseId: required("PRODUCTION_TARGET_RELEASE_ID"),
      targetVersion: "0.9.12",
      probeVersion: "0.9.11",
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
    if (windows) {
      stage = "sdk-installer-observer"
      sdkObserver = await observeSdkInstaller(assets.target.windowsInstaller.sha256)
    }
    stage = "production-sdk-update"
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
    const candidate = rows.find((row) => row.event === "production-candidate")
    assert(started && candidate)
    assert.equal(started.version, "0.9.11")
    assert.notEqual(started.pid, baselinePid, "Diagnostic probe reused the baseline PID")
    assert.equal(started.detail.targetSource, guard.targetSha)
    assert.equal(started.detail.probeSource, guard.harnessSha)
    assert.equal(started.detail.trust, "production")
    assert.equal(
      started.detail.metadataSource,
      "https://api.github.com/repos/Omnividente/omp-desktop/releases",
    )
    assert.equal(candidate.detail.version, "0.9.12")
    assert.equal(candidate.detail.releaseId, guard.releaseId)
    assert.equal(
      candidate.detail.releaseUrl,
      "https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.12",
    )
    assert.equal(candidate.detail.prerelease, true)
    result.probe.pid = started.pid
    result.probe.launcherPid = child.pid
    stage = "first-sdk-target-native-ui"
    const first = await observe([basename(f.project), f.title], "sdk-first-target-native", {
      version: "0.9.12",
      excludePids: [baselinePid, started.pid],
    })
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
      result.targetPe = await pe(executable, "0.9.12")
      const registrationsAfter = await registrations()
      assert.equal(registrationsAfter.length, 1)
      assert.equal(registrationsAfter[0].version, "0.9.12")
      result.targetRegistrations = registrationsAfter
    }
    result.launches.push({
      label: "FIRST-SDK-RELAUNCH",
      ...first,
      expectedVersion: "0.9.12",
      imageSha256: await hash(executable),
      controllerLaunch: false,
    })
    if (windows) {
      stage = "sdk-installer-identity"
      result.sdkInstaller = await sdkObserver.result
      assert(result.sdkInstaller, "Actual production SDK installer PID/hash was not observed")
      await proof("production-sdk-installer.json", result.sdkInstaller)
    }
    // Only diagnostic events are copied after a strict allowlist; TARGET has no marker.
    const allowed = new Set([
      "production-started",
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
  assert.deepEqual(await state(f, "0.9.12", "target-first"), expected)
  await preferences(f, false)
  await close()
  stage = "target-normal-restart"
  await start("target-restarted", "0.9.12", [baselinePid, firstPid])
  assert.deepEqual(await state(f, "0.9.12", "target-restarted"), expected)
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
    reason: "Production native contract failed (private raw errors not retained)",
  }
  process.exitCode = 1
  if (result.lastNativeOperation && executable && evidence) {
    const failedOperation = result.lastNativeOperation
    const failedDetail = result.lastNativeFailure
    try {
      result.failure.nativeWindow = await native({
        operation: "capture",
        pid: activePid ?? undefined,
        screenshot: join(evidence, "native-failure.png"),
      })
    } catch {
      // An unavailable owned window remains a gate failure, never a fallback.
    }
    result.lastNativeOperation = failedOperation
    if (failedDetail) result.lastNativeFailure = failedDetail
    else delete result.lastNativeFailure
  }
} finally {
  sdkObserver?.stop()
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

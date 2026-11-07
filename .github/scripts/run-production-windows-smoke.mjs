// Normal production NSIS installation, NOT the built-in updater gate.
// Run only on a disposable GitHub-hosted Windows runner. No product overrides.
// Inputs: PRODUCTION_RECEIPT, PRODUCTION_SCENARIO=clean|upgrade,
// PRODUCTION_SMOKE_WORK_DIR (new RUNNER_TEMP child), PRODUCTION_EVIDENCE_DIR,
// PRODUCTION_TARGET_SHA, PRODUCTION_TARGET_RELEASE_ID, PRODUCTION_TARGET_RUN_ID,
// PRODUCTION_HARNESS_SHA (the independently pinned signed workflow/helper source).
// Evidence only is uploaded; never upload the working directory or native profile.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const BASE_COMMIT = "73e661504b3d3d0a4b382e3289b02355b7400699"
const BASE_TAG_OBJECT = "b901b14eaf5f13c23e33d9ba84dd31b62d02a540"
const WEBVIEW2_DOC =
  "https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code#using-an-environment-variable"
// Microsoft documents WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port
// for already-built Win32 WebView2 hosts. Checked 2026-11-07. This changes only
// the diagnostic engine capability, never the EXE, Tauri configuration or trust.
const HOST = "127.0.0.1"
const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let stage = "environment"
let evidenceDir
let active
let childEnv
let powershell
const result = {
  status: "FAIL",
  gate: null,
  webview2CapabilitySource: WEBVIEW2_DOC,
  limits: [
    "Normal NSIS replacement, not built-in updater discovery/signature/install/relaunch.",
    "GitHub-hosted Windows Server desktop is not consumer Windows 11 coverage.",
    "Synthetic persisted transcript only; no CLI, provider inference or credentials.",
    "Native screenshots require an interactive visible HWND; unavailable GUI is failure.",
    "Production artifact signatures/provenance are attested by the acquisition receipt; this helper rehashes its exact installer bytes.",
  ],
  launches: [],
  installers: [],
}

function requireThat(condition, label) {
  if (!condition) throw new Error(label)
}
function envRequired(name) {
  const value = process.env[name]
  requireThat(typeof value === "string" && value.length > 0, `Missing ${name}`)
  return value
}
function inside(parent, child) {
  const suffix = relative(parent, child)
  return suffix !== "" && !suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix)
}
function samePath(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    resolve(a).toLowerCase() === resolve(b).toLowerCase()
  )
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
async function hash(path) {
  const digest = createHash("sha256")
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest("hex")
}
async function jsonProof(name, data) {
  await writeFile(join(evidenceDir, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" })
}
async function waitUntil(label, callback, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await callback()
    if (value) return value
    await sleep(400)
  }
  throw new Error(`Timed out: ${label}`)
}

// Never inherit runner tokens, ACTIONS_*, provider variables, user PATH, NODE_OPTIONS,
// TAURI_* or any other ambient application configuration into an installer/app.
function environment() {
  const output = {}
  for (const key of [
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
    "NUMBER_OF_PROCESSORS",
  ]) {
    if (process.env[key]) output[key] = process.env[key]
  }
  output.PATH = [
    join(envRequired("SystemRoot"), "System32"),
    envRequired("SystemRoot"),
    join(envRequired("SystemRoot"), "System32", "Wbem"),
  ].join(";")
  return output
}
function command(executable, args, extraEnv = {}, timeout = 60_000, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      ...options,
      env: { ...childEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let oversized = false
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 1024 * 1024) oversized = true
      else stdout += chunk.toString("utf8")
    })
    // Do not retain raw stderr: native exceptions may contain ambient private data.
    child.stderr.resume()
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Owned child command timeout"))
    }, timeout)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Owned child command failed to start"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 || oversized)
        reject(new Error(`Owned child command failed (exit ${code}, oversized ${oversized})`))
      else done({ stdout, pid: child.pid })
    })
  })
}
async function ps(script, variables = {}) {
  const { stdout } = await command(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`,
    ],
    variables,
  )
  return JSON.parse(stdout.replace(/^\uFEFF/, ""))
}
async function registrations(label) {
  const rows = await ps(
    `$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); $items=@(foreach($root in $roots){ if(Test-Path $root){ Get-ChildItem $root | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DisplayName -match '(?i)OMP[ -]?Desktop' -or $_.PSChildName -eq 'com.ompdesk.desktop'){ [pscustomobject]@{key=$_.Name;name=$p.DisplayName;version=$p.DisplayVersion;location=$p.InstallLocation;uninstall=$p.UninstallString} } } } }); ConvertTo-Json -InputObject $items -Depth 4 -Compress`,
  )
  requireThat(Array.isArray(rows), "Uninstall inventory schema")
  await jsonProof(`uninstall-${label}.json`, rows)
  return rows
}
async function productionProcesses() {
  return ps(
    `$items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'omp-desktop.exe' -or $_.Name -ieq 'OMP Desktop.exe' -or $_.ExecutablePath -match '(?i)\\\\OMP Desktop\\\\' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;path=$_.ExecutablePath} }); ConvertTo-Json -InputObject $items -Compress`,
  )
}
async function files(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    requireThat(!entry.isSymbolicLink(), "Installed symlink is not accepted")
    if (entry.isDirectory()) output.push(...(await files(path)))
    else if (entry.isFile()) output.push(path)
  }
  return output
}
async function pe(path) {
  return ps(
    `$v=(Get-Item -LiteralPath $env:SMOKE_EXE).VersionInfo; [pscustomobject]@{path=$env:SMOKE_EXE;product=$v.ProductName;productVersion=$v.ProductVersion;fileVersion=$v.FileVersion;fileMajor=$v.FileMajorPart;fileMinor=$v.FileMinorPart;fileBuild=$v.FileBuildPart;productMajor=$v.ProductMajorPart;productMinor=$v.ProductMinorPart;productBuild=$v.ProductBuildPart} | ConvertTo-Json -Compress`,
    { SMOKE_EXE: path },
  )
}
async function install(release, installDir, label) {
  stage = `install-${label}`
  requireThat(
    (await productionProcesses()).length === 0,
    "Production process exists before install",
  )
  const installer = release.windowsInstaller
  requireThat(
    (await hash(installer.path)) === installer.sha256,
    "Installer hash changed before launch",
  )
  const run = await command(installer.path, ["/S", `/D=${installDir}`], {}, 240_000, {
    windowsVerbatimArguments: true,
  })
  result.installers.push({
    label,
    path: installer.path,
    sha256: installer.sha256,
    pid: run.pid,
    exitCode: 0,
    arguments: ["/S", `/D=${installDir}`],
  })
  const rows = await registrations(`after-${label}`)
  requireThat(
    rows.length === 1 && rows[0].name === "OMP Desktop" && rows[0].version === release.version,
    "Installed uninstall identity/version mismatch",
  )
  // NSIS stores InstallLocation as a quoted directory, not a bare filesystem path.
  const registeredLocation = rows[0].location
  requireThat(
    typeof registeredLocation === "string" &&
      samePath(registeredLocation.replace(/^"([^"]+)"$/, "$1"), installDir),
    "Uninstall install location mismatch",
  )
  requireThat(
    typeof rows[0].uninstall === "string" &&
      rows[0].uninstall.toLowerCase().includes(installDir.toLowerCase()),
    "Uninstaller does not belong to own install directory",
  )
  const candidates = (await files(installDir)).filter(
    (path) => basename(path).toLowerCase() === "omp-desktop.exe",
  )
  requireThat(candidates.length === 1, "Expected exactly one production omp-desktop.exe")
  const executable = candidates[0]
  const version = await pe(executable)
  requireThat(version.product === "OMP Desktop", "PE product identity mismatch")
  for (const prefix of ["file", "product"]) {
    requireThat(
      `${version[`${prefix}Major`]}.${version[`${prefix}Minor`]}.${version[`${prefix}Build`]}` ===
        release.version,
      "PE version mismatch",
    )
  }
  requireThat(
    (await productionProcesses()).length === 0,
    "Installer unexpectedly launched production app",
  )
  return { executable, sha256: await hash(executable), version, release }
}

// A visible, foreground, non-minimized real HWND is mandatory, not just a CDP page.
// CopyFromScreen captures the actual native surface; screenshots are never DOM mocks.
const WINDOW_API = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int height,bool repaint);
}
'@;`
async function nativeIdentity(app, screenshot) {
  const data = await ps(
    `${WINDOW_API}
$p=Get-Process -Id ([int]$env:SMOKE_PID); $p.Refresh(); $h=$p.MainWindowHandle;
if($p.Path -ine $env:SMOKE_EXE){throw 'Wrong native process'};
if($h -eq 0 -or -not [SmokeWindow]::IsWindowVisible($h) -or [SmokeWindow]::IsIconic($h)){ throw 'No visible native window' };
$r=New-Object SmokeWindow+Rect; if(-not [SmokeWindow]::GetWindowRect($h,[ref]$r)){throw 'No bounds'};
[uint32]$owner=0; [void][SmokeWindow]::GetWindowThreadProcessId($h,[ref]$owner);
if($owner -ne $p.Id -or $r.Right-$r.Left -lt 800 -or $r.Bottom-$r.Top -lt 500){throw 'Bad surface'};
Add-Type -AssemblyName System.Windows.Forms;
$area=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $w=[Math]::Min(1440,$area.Width-16); $height=[Math]::Min(900,$area.Height-16);
if($w -lt 1000 -or $height -lt 650){throw 'Desktop smaller than supported native surface'};
if(-not [SmokeWindow]::MoveWindow($h,($area.Left+8),($area.Top+8),$w,$height,$true)){throw 'Cannot position own window'};
if(-not [SmokeWindow]::GetWindowRect($h,[ref]$r)){throw 'No adjusted bounds'};
if($env:SMOKE_SCREENSHOT){
 [void][SmokeWindow]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300;
 if([SmokeWindow]::GetForegroundWindow() -ne $h){throw 'Not foreground'};
 Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms;
 $screen=[Windows.Forms.SystemInformation]::VirtualScreen;
 if($r.Left -lt $screen.Left -or $r.Top -lt $screen.Top -or $r.Right -gt $screen.Right -or $r.Bottom -gt $screen.Bottom){throw 'Window outside desktop'};
 $bmp=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top); $g=[Drawing.Graphics]::FromImage($bmp);
 try { $g.CopyFromScreen($r.Left,$r.Top,0,0,$bmp.Size); $colors=New-Object 'Collections.Generic.HashSet[int]'; for($x=0;$x -lt $bmp.Width;$x+=[Math]::Max(1,[int]($bmp.Width/64))){ for($y=0;$y -lt $bmp.Height;$y+=[Math]::Max(1,[int]($bmp.Height/48))){ [void]$colors.Add($bmp.GetPixel($x,$y).ToArgb()) } }; if($colors.Count -lt 9){throw 'Blank native capture'}; $bmp.Save($env:SMOKE_SCREENSHOT,[Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }
};
[pscustomobject]@{pid=$p.Id;path=$p.Path;started=$p.StartTime.ToUniversalTime().ToString('o');hwnd=$h.ToInt64();ownerPid=$owner;title=$p.MainWindowTitle;visible=$true;bounds=@{left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom}} | ConvertTo-Json -Depth 4 -Compress`,
    {
      SMOKE_PID: String(app.child.pid),
      SMOKE_EXE: app.binary.executable,
      SMOKE_SCREENSHOT: screenshot ?? "",
    },
  )
  requireThat(
    data.pid === app.child.pid &&
      data.ownerPid === app.child.pid &&
      samePath(data.path, app.binary.executable),
    "Native PID/path/owner mismatch",
  )
  requireThat(data.title === "OMP Desktop", "Native window title mismatch")
  requireThat((await hash(data.path)) === app.binary.sha256, "Running production PE changed")
  return data
}
async function cdpOwner(app, port) {
  return ps(
    `$connections=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:SMOKE_PORT) -ErrorAction SilentlyContinue); if($connections.Count -eq 0){ ConvertTo-Json -InputObject $null; exit }; $owners=@(); foreach($c in $connections){ if($c.LocalAddress -ne '127.0.0.1' -and $c.LocalAddress -ne '::1'){ throw 'CDP not loopback' }; $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess); if($owner.Name -ine 'msedgewebview2.exe'){throw 'Not WebView2'}; $p=$owner; $found=$false; for($n=0;$n -lt 20 -and $p;$n++){ if($p.ProcessId -eq [int]$env:SMOKE_PID){$found=$true;break}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId) }; if(-not $found){throw 'Foreign CDP listener'}; $owners+= [pscustomobject]@{pid=$owner.ProcessId;parentPid=$owner.ParentProcessId;path=$owner.ExecutablePath;address=$c.LocalAddress;port=$c.LocalPort} }; ConvertTo-Json -InputObject $owners -Compress`,
    { SMOKE_PID: String(app.child.pid), SMOKE_PORT: String(port) },
  )
}
async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once("error", reject)
    server.listen(0, HOST, done)
  })
  const port = server.address().port
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
  return port
}
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 0
    this.pending = new Map()
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(`CDP command failed: ${request.method}`))
      else request.done(message.result)
    })
    const closed = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error("CDP closed"))
      }
      this.pending.clear()
    }
    socket.addEventListener("close", closed)
    socket.addEventListener("error", closed)
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((done, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error("CDP WebSocket timeout"))
      }, 15_000)
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          done()
        },
        { once: true },
      )
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("CDP WebSocket unavailable"))
        },
        { once: true },
      )
    })
    return new Cdp(socket)
  }
  send(method, params = {}) {
    const id = ++this.next
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, { done, reject, timer, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    requireThat(
      !response.exceptionDetails && response.result?.subtype !== "error",
      "Native WebView evaluation failed",
    )
    return response.result?.value
  }
  invoke(name, args = {}) {
    return this.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`,
    )
  }
  close() {
    this.socket.close()
  }
}
async function start(binary, label) {
  stage = `startup-${label}`
  requireThat((await productionProcesses()).length === 0, "Foreign or surviving production process")
  requireThat((await hash(binary.executable)) === binary.sha256, "EXE changed before startup")
  const port = await freePort()
  const child = spawn(binary.executable, [], {
    cwd: dirname(binary.executable),
    env: { ...childEnv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
    windowsHide: false,
  })
  const app = { child, binary, label, port, exited: false }
  active = app
  child.once("error", () => {
    app.exited = true
    app.launchError = true
  })
  child.once("exit", (code, signal) => {
    app.exited = true
    app.exitCode = code
    app.signal = signal
  })
  await waitUntil("own WebView2 listener", async () => {
    requireThat(!app.exited, "Production process exited before GUI ready")
    return await cdpOwner(app, port)
  })
  const targets = await waitUntil("production Tauri target", async () => {
    const response = await fetch(`http://${HOST}:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    })
    requireThat(response.ok, "CDP target inventory failed")
    const pages = (await response.json()).filter((target) => target.type === "page")
    if (pages.length === 0) return null
    requireThat(pages.length === 1, "Ambiguous CDP surface")
    const page = pages[0]
    if (page.url === "about:blank" || !page.title) return null
    requireThat(page.title === "OMP Desktop", "CDP target title mismatch")
    const url = new URL(page.url)
    requireThat(
      url.origin === "http://tauri.localhost" &&
        ["/", "/index.html"].includes(url.pathname) &&
        !url.search &&
        !url.hash,
      "Not bundled production Tauri URL",
    )
    const ws = new URL(page.webSocketDebuggerUrl)
    requireThat(
      ws.protocol === "ws:" &&
        [HOST, "localhost", "[::1]"].includes(ws.hostname) &&
        ws.port === String(port),
      "Foreign CDP WebSocket endpoint",
    )
    return page
  })
  app.cdp = await Cdp.connect(targets.webSocketDebuggerUrl)
  await app.cdp.send("Page.enable")
  await waitUntil("native bridge and rendered UI", () =>
    app.cdp.evaluate(
      `document.readyState === 'complete' && document.title === 'OMP Desktop' && typeof window.__TAURI_INTERNALS__?.invoke === 'function' && !!document.querySelector('.app-version') && document.querySelector('#root')?.children.length > 0`,
    ),
  )
  const version = await app.cdp.invoke("plugin:app|version")
  const identifier = await app.cdp.invoke("plugin:app|identifier")
  const name = await app.cdp.invoke("plugin:app|name")
  requireThat(
    version === binary.release.version &&
      identifier === "com.ompdesk.desktop" &&
      name === "OMP Desktop",
    "Native app metadata mismatch",
  )
  const window = await nativeIdentity(app)
  const identity = {
    label,
    ...window,
    sha256: binary.sha256,
    pe: binary.version,
    nativeVersion: version,
    identifier,
    name,
    target: { id: targets.id, url: targets.url, title: targets.title },
    webview2: await cdpOwner(app, port),
  }
  await jsonProof(`${label}-identity.json`, identity)
  result.launches.push(identity)
  return app
}
async function click(app, selector) {
  await waitUntil(`UI control ${selector}`, () =>
    app.cdp.evaluate(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); return !!e && !e.disabled && e.getClientRects().length > 0 })()`,
    ),
  )
  const point = await app.cdp.evaluate(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const p={x:r.x+r.width/2,y:r.y+r.height/2}; return e.contains(document.elementFromPoint(p.x,p.y)) ? p : null })()`,
  )
  requireThat(point, "UI control is obscured or outside the native viewport")
  await app.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  })
  await app.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  })
}
async function select(app, selector, value) {
  // Native select's actual change event goes through React's existing onChange.
  const changed = await app.cdp.evaluate(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!(e instanceof HTMLSelectElement) || ![...e.options].some(o=>o.value===${JSON.stringify(value)})) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
  )
  requireThat(changed, "Missing native preferences select option")
}
async function screenshot(app, name, native = false) {
  requireThat(
    await app.cdp.evaluate(
      `location.origin === 'http://tauri.localhost' && document.title === 'OMP Desktop' && document.querySelector('.app-version')?.textContent.includes(${JSON.stringify(app.binary.release.version)})`,
    ),
    "Screenshot surface identity/readiness mismatch",
  )
  if (native) await nativeIdentity(app, join(evidenceDir, `${name}-native.png`))
  const { data } = await app.cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const bytes = Buffer.from(data, "base64")
  requireThat(
    bytes.length > 5_000 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    "Empty/invalid WebView screenshot",
  )
  await writeFile(join(evidenceDir, `${name}-cdp.png`), bytes, { flag: "wx" })
}
function settingsView(settings) {
  requireThat(
    settings &&
      Array.isArray(settings.providerEnvKeys) &&
      settings.providerEnvKeys.length === 0 &&
      !settings.providerEnv,
    "Unexpected credential-bearing settings",
  )
  requireThat(
    !settings.settingsWarning && !settings.secretStorageWarning,
    "Native settings recovery/warning is not success",
  )
  // Compare durable user choices, not incidental additions to the IPC schema.
  // Legacy 0.9.10 has no theme preference and renders the dark interface.
  return {
    ompExecutable: settings.ompExecutable,
    sessionRoot: settings.sessionRoot,
    language: settings.language,
    desktopTheme: settings.desktopTheme ?? "dark",
    appFontFamily: settings.appFontFamily,
    appFontSize: settings.appFontSize,
    terminalFontFamily: settings.terminalFontFamily,
    terminalFontSize: settings.terminalFontSize,
    railMode: settings.railMode,
    recentWorkspaces: settings.recentWorkspaces,
    lastWorkspace: settings.lastWorkspace,
    workspaceNames: settings.workspaceNames ?? {},
    hiddenWorkspaces: settings.hiddenWorkspaces ?? [],
    sessionTitlePins: settings.sessionTitlePins ?? {},
    primaryProviderPins: settings.primaryProviderPins ?? [],
    proxyProviders: settings.proxyProviders ?? [],
    providerEnvKeys: settings.providerEnvKeys,
  }
}
async function state(app, fixture) {
  const payload = await app.cdp.invoke("bootstrap")
  requireThat(
    !payload.startupWorkspaceWarning && payload.sessionWarnings?.length === 0,
    "Bootstrap warning",
  )
  requireThat(
    payload.runtime.platform === "windows" &&
      payload.runtime.ompAvailable === false &&
      samePath(payload.runtime.ompExecutable, fixture.noCli) &&
      samePath(payload.runtime.sessionRoot, fixture.sessions),
    "Unexpected native runtime/CLI/session root",
  )
  const settings = settingsView(payload.settings)
  requireThat(
    settings.language === "en" &&
      settings.appFontSize === 22 &&
      settings.terminalFontSize === 16 &&
      settings.desktopTheme === fixture.theme,
    "Native preferences mismatch",
  )
  requireThat(
    samePath(settings.lastWorkspace, fixture.project) &&
      samePath(settings.sessionRoot, fixture.sessions) &&
      samePath(settings.ompExecutable, fixture.noCli),
    "Native persisted paths mismatch",
  )
  requireThat(
    payload.workspaces.length === 1 &&
      samePath(payload.workspaces[0].path, fixture.project) &&
      payload.workspaces[0].name === basename(fixture.project),
    "Workspace identity mismatch",
  )
  requireThat(
    payload.sessions.length === 1 &&
      payload.sessions[0].id === fixture.id &&
      payload.sessions[0].title === fixture.title &&
      samePath(payload.sessions[0].filePath, fixture.session) &&
      samePath(payload.sessions[0].cwd, fixture.project),
    "Session identity mismatch",
  )
  const transcript = await app.cdp.invoke("read_session_transcript", { path: fixture.session })
  requireThat(
    transcript.malformedRecords === 0 &&
      transcript.incompleteLastRecord === false &&
      transcript.truncated === false,
    "Transcript not fully parsed",
  )
  assert.deepEqual(
    transcript.entries.map(({ role, text }) => ({ role, text })),
    fixture.messages,
    "Actual native transcript content mismatch",
  )
  requireThat(
    (await hash(fixture.session)) === fixture.sessionHash &&
      (await hash(fixture.projectFile)) === fixture.projectHash,
    "Synthetic content bytes changed",
  )
  const disk = settingsView(JSON.parse(await readFile(fixture.settingsFile, "utf8")))
  assert.deepEqual(disk, settings, "Native bootstrap differs from durable settings")
  return {
    settings,
    workspaces: payload.workspaces.map(({ path, name }) => ({ path, name })),
    sessions: payload.sessions.map(({ id, filePath, cwd, title }) => ({
      id,
      filePath,
      cwd,
      title,
    })),
    transcript: transcript.entries.map(({ role, text }) => ({ role, text })),
    sessionSha256: fixture.sessionHash,
    workspaceContentSha256: fixture.projectHash,
  }
}
async function preferences(app, fixture, initial = false) {
  await click(app, '.topbar button[title="Settings"]')
  await waitUntil("general preferences", () =>
    app.cdp.evaluate(`!!document.querySelector('#language-select')`),
  )
  if (initial) {
    await select(app, "#language-select", "en")
    await select(app, "#app-font-size", "22")
    if (fixture.theme === "light") await select(app, "#desktop-theme-select", "light")
    await click(app, "#settings-tab-behavior")
    await waitUntil("terminal font preferences", () =>
      app.cdp.evaluate(`!!document.querySelector('#terminal-font-size')`),
    )
    await select(app, "#terminal-font-size", "16")
    await click(app, ".settings-panel .settings-actions .primary")
    await waitUntil("native settings commit", async () => {
      const { settings } = await app.cdp.invoke("bootstrap")
      return (
        settings.language === "en" &&
        settings.appFontSize === 22 &&
        settings.terminalFontSize === 16 &&
        (settings.desktopTheme ?? "dark") === fixture.theme
      )
    })
    // Observe the actual panel after commit; never repeat Save or treat its
    // disabled state as proof of successful durable persistence.
    requireThat(
      await app.cdp.evaluate(`!!document.querySelector('.settings-panel')`),
      "Settings panel disappeared after Save",
    )
    await click(app, "#settings-tab-general")
    await waitUntil("saved general preferences rendered", () =>
      app.cdp.evaluate(`!!document.querySelector('#app-font-size')`),
    )
  }
  const general = await app.cdp.evaluate(
    `(() => ({language:document.querySelector('#language-select')?.value,font:document.querySelector('#app-font-size')?.value,theme:document.querySelector('#desktop-theme-select')?.value ?? null,sessionRoot:document.querySelector('#session-root')?.value,executable:document.querySelector('#omp-executable')?.value}))()`,
  )
  requireThat(
    general.language === "en" &&
      general.font === "22" &&
      (general.theme ?? "dark") === fixture.theme &&
      samePath(general.sessionRoot, fixture.sessions) &&
      samePath(general.executable, fixture.noCli),
    "Rendered general preferences differ",
  )
  if (app.binary.release.version === "0.9.11") {
    requireThat(general.theme === fixture.theme, "Target theme UI missing")
    await waitUntil("applied Desktop theme", () =>
      app.cdp.evaluate(
        `document.documentElement.getAttribute('data-desktop-theme') === ${JSON.stringify(fixture.theme)}`,
      ),
    )
  }
  await screenshot(app, `${app.label}-preferences`)
  await click(app, "#settings-tab-behavior")
  await waitUntil("rendered terminal preferences", () =>
    app.cdp.evaluate(`!!document.querySelector('#terminal-font-size')`),
  )
  const font = await app.cdp.evaluate(`document.querySelector('#terminal-font-size')?.value`)
  requireThat(font === "16", "Rendered terminal font differs")
  await screenshot(app, `${app.label}-terminal-preferences`)
  await jsonProof(`${app.label}-preferences-ui.json`, {
    general,
    terminalFontSize: font,
    appliedTheme: await app.cdp.evaluate(
      `document.documentElement.getAttribute('data-desktop-theme')`,
    ),
    method: initial
      ? "Actual UI preferences change + Save"
      : "Read rendered saved preferences without mutation",
  })
  await click(app, ".settings-panel .settings-actions .secondary")
  await waitUntil("preferences closed", () =>
    app.cdp.evaluate(`!document.querySelector('.settings-panel')`),
  )
}
async function proveUi(app, fixture) {
  await waitUntil("rendered workspace and session", () =>
    app.cdp.evaluate(
      `(() => { const project=[...document.querySelectorAll('.project-copy strong')].some(e=>e.textContent===${JSON.stringify(basename(fixture.project))}); const session=[...document.querySelectorAll('.session-select')].some(e=>e.getAttribute('aria-label')===${JSON.stringify(fixture.title)}); return project && session })()`,
    ),
  )
  await screenshot(app, `${app.label}-workspace`, true)
  await click(app, ".session-transcript")
  await waitUntil("visible native transcript content", () =>
    app.cdp.evaluate(
      `(() => { const e=document.querySelector('.transcript-panel'); return !!e && document.querySelector('#transcript-title')?.textContent===${JSON.stringify(fixture.title)} && ${JSON.stringify(fixture.messages.map((message) => message.text))}.every(t=>e.innerText.includes(t)) })()`,
    ),
  )
  await screenshot(app, `${app.label}-transcript`, true)
  await click(app, '.transcript-header-actions button[title="Close"]')
  const versionText = await app.cdp.evaluate(`document.querySelector('.app-version')?.textContent`)
  requireThat(versionText?.includes(app.binary.release.version), "Rendered app version mismatch")
}
async function close(app) {
  stage = `graceful-close-${app.label}`
  const before = await nativeIdentity(app)
  requireThat(before.pid === app.child.pid, "Graceful close ownership mismatch")
  const closed = await ps(
    `$p=Get-Process -Id ([int]$env:SMOKE_PID); if($p.Path -ine $env:SMOKE_EXE){throw 'Wrong process'}; $accepted=$p.CloseMainWindow(); [pscustomobject]@{accepted=$accepted} | ConvertTo-Json -Compress`,
    { SMOKE_PID: String(app.child.pid), SMOKE_EXE: app.binary.executable },
  )
  requireThat(closed.accepted, "WM_CLOSE was not accepted")
  await waitUntil("graceful production exit", async () => app.exited, 30_000)
  requireThat(app.exitCode === 0 && !app.signal, "Production did not exit cleanly")
  app.cdp.close()
  requireThat(
    (await productionProcesses()).length === 0,
    "Production process survived graceful close",
  )
  await waitUntil(
    "owned WebView2 listener shutdown",
    () =>
      ps(
        `$listeners=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:SMOKE_PORT) -ErrorAction SilentlyContinue); ConvertTo-Json -InputObject ($listeners.Count -eq 0)`,
        { SMOKE_PORT: String(app.port) },
      ),
    30_000,
  )
  requireThat(
    (await hash(app.binary.executable)) === app.binary.sha256,
    "EXE changed during runtime",
  )
  await jsonProof(`${app.label}-close.json`, {
    pid: app.child.pid,
    method: "CloseMainWindow/WM_CLOSE",
    exitCode: app.exitCode,
  })
  active = null
}
async function validateRelease(release, version) {
  requireThat(
    release?.version === version &&
      release.tag === `v${version}` &&
      SHA1.test(release.commit) &&
      SHA1.test(release.tagObjectSha) &&
      /^\d+$/.test(String(release.releaseId)),
    "Receipt release identity schema mismatch",
  )
  requireThat(
    isAbsolute(release.assetsDir) && Array.isArray(release.assets) && release.assets.length > 0,
    "Receipt asset directory/schema mismatch",
  )
  const names = new Set(),
    ids = new Set()
  for (const asset of release.assets) {
    requireThat(
      typeof asset.name === "string" &&
        basename(asset.name) === asset.name &&
        !names.has(asset.name) &&
        !ids.has(String(asset.id)) &&
        /^\d+$/.test(String(asset.id)) &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        SHA256.test(asset.sha256),
      "Receipt asset inventory mismatch",
    )
    names.add(asset.name)
    ids.add(String(asset.id))
  }
  const installer = release.windowsInstaller
  requireThat(
    installer &&
      isAbsolute(installer.path) &&
      SHA256.test(installer.sha256) &&
      /setup\.exe$/i.test(installer.path),
    "Receipt NSIS installer schema mismatch",
  )
  const asset = release.assets.find((item) => item.name === basename(installer.path))
  requireThat(
    asset?.sha256 === installer.sha256 && samePath(dirname(installer.path), release.assetsDir),
    "Installer not bound to verified asset inventory",
  )
  requireThat(
    samePath(await realpath(installer.path), installer.path) &&
      (await stat(installer.path)).size === asset.bytes,
    "Installer path/size mismatch",
  )
}
async function main() {
  requireThat(
    process.platform === "win32" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "Requires fresh ephemeral GitHub-hosted Windows VM",
  )
  requireThat(
    Number(process.versions.node.split(".")[0]) >= 22 && typeof WebSocket === "function",
    "Node 22+ native WebSocket required",
  )
  const harnessSha = envRequired("PRODUCTION_HARNESS_SHA")
  requireThat(
    SHA1.test(harnessSha) && process.env.GITHUB_SHA === harnessSha,
    "Acceptance harness identity not pinned to workflow source",
  )
  result.harnessIdentity = { commit: harnessSha }
  const scenario = envRequired("PRODUCTION_SCENARIO")
  requireThat(["clean", "upgrade"].includes(scenario), "Expected clean or upgrade scenario")
  result.gate = `production-normal-nsis-${scenario === "clean" ? "clean-startup" : "upgrade-state"}`
  const runnerTemp = await realpath(envRequired("RUNNER_TEMP"))
  const work = resolve(envRequired("PRODUCTION_SMOKE_WORK_DIR"))
  requireThat(
    inside(runnerTemp, work) && (await absent(work)) && !/[\r\n\"]/.test(work),
    "Work directory must be new and owned under RUNNER_TEMP",
  )
  const proof = resolve(envRequired("PRODUCTION_EVIDENCE_DIR"))
  requireThat(
    inside(runnerTemp, proof) &&
      !samePath(work, proof) &&
      !inside(work, proof) &&
      !inside(proof, work),
    "Evidence directory must be separate under RUNNER_TEMP",
  )
  for (const directory of [work, proof]) {
    let ancestor = directory
    while (await absent(ancestor)) ancestor = dirname(ancestor)
    requireThat(
      samePath(await realpath(ancestor), ancestor),
      "Runner temporary directory ancestor must not be redirected",
    )
  }
  await mkdir(proof, { recursive: true })
  requireThat(samePath(await realpath(proof), proof), "Evidence directory must not be redirected")
  evidenceDir = proof
  requireThat(
    await absent(join(proof, "production-windows-result.json")),
    "Evidence must not reuse a previous result",
  )
  await mkdir(work, { recursive: true })
  requireThat(samePath(await realpath(work), work), "Work directory must not be redirected")
  childEnv = environment()
  powershell = join(childEnv.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  stage = "receipt"
  const receiptPath = resolve(envRequired("PRODUCTION_RECEIPT"))
  requireThat(
    samePath(receiptPath, join(evidenceDir, "verified-production-assets.json")),
    "Receipt must be the acquisition evidence artifact",
  )
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  requireThat(receipt.repository === "Omnividente/omp-desktop", "Receipt repository mismatch")
  await validateRelease(receipt.base, "0.9.10")
  await validateRelease(receipt.target, "0.9.11")
  requireThat(
    receipt.base.commit === BASE_COMMIT &&
      receipt.base.tagObjectSha === BASE_TAG_OBJECT &&
      String(receipt.base.releaseId) === "413772482",
    "Fixed base identity mismatch",
  )
  requireThat(
    /^\d+$/.test(String(receipt.target.releaseRunId)) &&
      receipt.target.commit === envRequired("PRODUCTION_TARGET_SHA") &&
      String(receipt.target.releaseId) === envRequired("PRODUCTION_TARGET_RELEASE_ID") &&
      String(receipt.target.releaseRunId) === envRequired("PRODUCTION_TARGET_RUN_ID"),
    "Target identity not pinned to workflow inputs",
  )
  result.receiptSha256 = await hash(receiptPath)
  result.releaseIdentity = {
    base: {
      version: receipt.base.version,
      commit: receipt.base.commit,
      releaseId: receipt.base.releaseId,
    },
    target: {
      version: receipt.target.version,
      commit: receipt.target.commit,
      releaseId: receipt.target.releaseId,
      runId: receipt.target.releaseRunId,
    },
  }
  stage = "fresh-account"
  const folders = await ps(
    `[pscustomobject]@{roaming=[Environment]::GetFolderPath('ApplicationData');local=[Environment]::GetFolderPath('LocalApplicationData');home=[Environment]::GetFolderPath('UserProfile');interactive=[Environment]::UserInteractive;session=(Get-Process -Id $PID).SessionId} | ConvertTo-Json -Compress`,
  )
  requireThat(
    folders.interactive &&
      folders.session > 0 &&
      samePath(folders.roaming, childEnv.APPDATA) &&
      samePath(folders.local, childEnv.LOCALAPPDATA) &&
      samePath(folders.home, childEnv.USERPROFILE),
    "No interactive native account/KnownFolders isolation",
  )
  const configDir = join(folders.roaming, "com.ompdesk.desktop")
  const localDir = join(folders.local, "com.ompdesk.desktop")
  for (const path of [configDir, localDir, join(folders.home, ".omp")])
    requireThat(await absent(path), "Production profile already exists; refusing to touch account")
  requireThat((await productionProcesses()).length === 0, "Existing production OMP process")
  requireThat(
    (await registrations("before")).length === 0,
    "Existing production OMP uninstall registration",
  )
  const fixture = {
    project: join(work, "Production smoke workspace"),
    sessions: join(work, "synthetic-sessions"),
    noCli: join(work, "intentionally-nonexistent-omp.exe"),
    settingsFile: join(configDir, "settings.json"),
    id: "production-normal-nsis-synthetic",
    title: "Production NSIS state survives",
    theme: scenario === "clean" ? "light" : "dark",
    messages: [
      { role: "user", text: "Synthetic user content before normal installation replacement." },
      { role: "assistant", text: "Synthetic saved answer persists byte-for-byte after restart." },
    ],
  }
  await mkdir(fixture.project)
  await mkdir(fixture.sessions)
  fixture.projectFile = join(fixture.project, "synthetic-workspace.txt")
  await writeFile(fixture.projectFile, "Production normal NSIS synthetic workspace content.\n", {
    flag: "wx",
  })
  fixture.projectHash = await hash(fixture.projectFile)
  fixture.session = join(fixture.sessions, "production-state.jsonl")
  const timestamp = "2026-11-07T00:00:00.000Z"
  const records = [
    {
      type: "session",
      version: 3,
      id: fixture.id,
      timestamp,
      cwd: fixture.project,
      title: fixture.title,
    },
    ...fixture.messages.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp,
      message: { ...message, content: [{ type: "text", text: message.text }] },
    })),
  ]
  await writeFile(
    fixture.session,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { flag: "wx" },
  )
  fixture.sessionHash = await hash(fixture.session)
  requireThat(await absent(fixture.noCli), "Synthetic CLI path unexpectedly exists")
  // Seed only the actual fresh account's production settings JSON. No identity,
  // KnownFolder, trust or runtime config override. The real UI performs Save below.
  await mkdir(configDir)
  await writeFile(
    fixture.settingsFile,
    `${JSON.stringify({ ompExecutable: fixture.noCli, sessionRoot: fixture.sessions, language: "en", appFontSize: 20, terminalFontSize: 14, recentWorkspaces: [fixture.project], lastWorkspace: fixture.project, railMode: "expanded" })}\n`,
    { flag: "wx" },
  )
  result.bootstrapMethod =
    "Fresh native settings JSON seeds synthetic paths and nonexistent CLI; real Settings UI changes preferences and Save commits them; native bootstrap+disk+rendered controls+transcript prove persistence."
  const installDir = join(work, "installed")
  let binary = await install(
    scenario === "upgrade" ? receipt.base : receipt.target,
    installDir,
    scenario === "upgrade" ? "base" : "target",
  )
  let app = await start(binary, scenario === "upgrade" ? "base-initial" : "target-initial")
  const initialBootstrap = await app.cdp.invoke("bootstrap")
  requireThat(
    initialBootstrap.runtime.ompAvailable === false &&
      samePath(initialBootstrap.runtime.ompExecutable, fixture.noCli),
    "Initial native bootstrap not synthetic",
  )
  await preferences(app, fixture, true)
  const expected = await state(app, fixture)
  await jsonProof(`${app.label}-state.json`, expected)
  await proveUi(app, fixture)
  await close(app)
  const diskAfterClose = settingsView(JSON.parse(await readFile(fixture.settingsFile, "utf8")))
  assert.deepEqual(diskAfterClose, expected.settings, "Initial graceful close changed preferences")
  if (scenario === "upgrade") {
    const baseHash = binary.sha256
    binary = await install(receipt.target, installDir, "target")
    requireThat(binary.sha256 !== baseHash, "Upgrade did not replace production PE")
    assert.deepEqual(
      settingsView(JSON.parse(await readFile(fixture.settingsFile, "utf8"))),
      expected.settings,
      "Normal installer changed saved preferences",
    )
  }
  // Both scenarios include a native process restart; upgrade also restarts the
  // target a second time without reseeding or another settings mutation.
  for (const label of scenario === "upgrade"
    ? ["target-upgraded", "target-restarted"]
    : ["target-restarted"]) {
    app = await start(binary, label)
    stage = `compare-${label}`
    const observed = await state(app, fixture)
    assert.deepEqual(observed, expected, "Strict persisted state differs after replacement/restart")
    await jsonProof(`${label}-state.json`, observed)
    await preferences(app, fixture)
    await proveUi(app, fixture)
    await close(app)
    assert.deepEqual(
      settingsView(JSON.parse(await readFile(fixture.settingsFile, "utf8"))),
      expected.settings,
      "Graceful close changed persisted settings",
    )
    requireThat(
      (await hash(fixture.session)) === fixture.sessionHash &&
        (await hash(fixture.projectFile)) === fixture.projectHash,
      "Content changed after graceful close",
    )
  }
  requireThat(
    (await hash(receiptPath)) === result.receiptSha256,
    "Acquisition receipt changed during smoke",
  )
  for (const installed of result.installers)
    requireThat(
      (await hash(installed.path)) === installed.sha256,
      "Verified installer changed during smoke",
    )
  stage = "complete"
  result.status = "PASS"
}

try {
  await main()
} catch (error) {
  // Only authored labels, not CDP exception payloads/headers/child stderr/DOM.
  result.failure = {
    stage,
    type: error instanceof assert.AssertionError ? "strict-state-mismatch" : "contract-failure",
    message:
      error instanceof assert.AssertionError
        ? "Strict persisted state comparison failed"
        : String(error.message).slice(0, 400),
  }
  process.exitCode = 1
} finally {
  if (active) {
    // Teardown is not a passing graceful close. Kill only our exact PID after
    // rechecking executable path, never taskkill /IM or a global process name.
    active.cdp?.close()
    if (!active.exited && childEnv && powershell) {
      try {
        await ps(
          `$p=Get-Process -Id ([int]$env:SMOKE_PID) -ErrorAction SilentlyContinue; if($p -and $p.Path -ieq $env:SMOKE_EXE){ Stop-Process -Id $p.Id -Force }; ConvertTo-Json -InputObject $true`,
          { SMOKE_PID: String(active.child.pid), SMOKE_EXE: active.binary.executable },
        )
        result.failureCleanup =
          "Stopped only owned app PID; disposable VM retains own directories/profile for teardown."
      } catch {
        result.failureCleanup = "Owned PID cleanup failed; dispose VM."
      }
    }
  }
  result.stage = stage
  if (evidenceDir) {
    try {
      await jsonProof("production-windows-result.json", result)
    } catch {
      process.exitCode = 1
      console.error("FAIL: could not persist production Windows evidence")
    }
  }
  if (!evidenceDir && result.failure) console.error(result.failure.message)
  console.log(
    `${process.exitCode ? "FAIL" : result.status}: ${result.gate ?? "production-normal-nsis"}; stage=${stage}`,
  )
}

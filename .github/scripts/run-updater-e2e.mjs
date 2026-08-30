import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises"
import { createServer } from "node:http"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const HOST = "127.0.0.1"
const PORT = 17823
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1_000

function updaterPlatform(platform) {
  if (platform === "win32") return "windows-x86_64"
  if (platform === "linux") return "linux-x86_64"
  throw new Error(`Updater E2E does not support ${platform}`)
}

export function buildUpdaterManifest({ platform, signature, targetVersion, assetUrl }) {
  if (!targetVersion?.trim()) throw new Error("Updater E2E target version is required")
  if (!signature?.trim()) throw new Error("Updater E2E signature is required")
  return {
    version: targetVersion,
    notes: `OMP Desktop updater E2E ${targetVersion}`,
    pub_date: "2026-01-01T00:00:00Z",
    platforms: {
      [updaterPlatform(platform)]: {
        signature: signature.trim(),
        url: assetUrl,
      },
    },
  }
}

export function validateMarkerEvents(events, baseVersion, targetVersion) {
  const failure = events.find((event) => event?.event === "error")
  if (failure) {
    throw new Error(
      `Updater E2E application error in ${failure.version ?? "unknown"}: ${failure.detail ?? "unknown"}`,
    )
  }
  const expected = [
    { event: "started", version: baseVersion, detail: null },
    { event: "update-found", version: baseVersion, detail: targetVersion },
    { event: "installed", version: baseVersion, detail: targetVersion },
    { event: "started", version: targetVersion, detail: null },
    { event: "complete", version: targetVersion, detail: null },
  ]
  let cursor = 0
  for (const event of events) {
    const wanted = expected[cursor]
    if (!wanted) break
    if (
      event?.event === wanted.event &&
      event?.version === wanted.version &&
      (event?.detail ?? null) === wanted.detail
    ) {
      cursor += 1
    }
  }
  if (cursor !== expected.length) {
    const wanted = expected[cursor]
    throw new Error(
      `Updater E2E marker is incomplete: expected ${wanted.event} ${wanted.version}, observed ${JSON.stringify(events)}`,
    )
  }
}

async function filesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesRecursively(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function singleFile(files, predicate, label) {
  const matches = files.filter(predicate)
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}: ${matches.join(", ")}`)
  }
  return matches[0]
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    })
    let output = ""
    const collect = (chunk) => {
      if (output.length < 64 * 1024) output += chunk.toString()
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ child, output })
      else reject(new Error(`${command} exited with code ${code} signal ${signal ?? "none"}: ${output}`))
    })
  })
}

async function readMarker(marker) {
  try {
    const text = await readFile(marker, "utf8")
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

async function waitForCompletion(marker, baseVersion, targetVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastEvents = []
  while (Date.now() < deadline) {
    lastEvents = await readMarker(marker)
    try {
      validateMarkerEvents(lastEvents, baseVersion, targetVersion)
      return lastEvents
    } catch (error) {
      if (lastEvents.some((event) => event?.event === "error")) throw error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error(`Updater E2E timed out; marker events: ${JSON.stringify(lastEvents)}`)
}

function startUpdateServer(manifest, targetAsset) {
  const targetRoute = `/target/${encodeURIComponent(basename(targetAsset))}`
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname
    if (pathname === "/latest.json") {
      const body = `${JSON.stringify(manifest)}\n`
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (pathname === targetRoute) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" })
      createReadStream(targetAsset).pipe(response)
      return
    }
    response.writeHead(404)
    response.end("not found")
  })
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(PORT, HOST, () => resolvePromise({ server, targetRoute }))
  })
}

async function launchWindowsBase(baseInstaller, workingRoot, marker, targetVersion) {
  const installDirectory = join(workingRoot, "installed")
  await rm(installDirectory, { recursive: true, force: true })
  await mkdir(installDirectory, { recursive: true })
  await runProcess(baseInstaller, ["/S", `/D=${installDirectory}`])
  const installedFiles = await filesRecursively(installDirectory)
  const executable = singleFile(
    installedFiles,
    (path) => basename(path).toLowerCase() === "omp-desktop-updater-e2e.exe",
    "installed updater E2E executable",
  )
  const child = spawn(
    executable,
    [`--updater-e2e-marker=${marker}`, `--updater-e2e-target=${targetVersion}`],
    { detached: false, stdio: "ignore", windowsHide: true },
  )
  child.unref()
  return installDirectory
}

async function launchLinuxBase(baseAppImage, workingRoot, marker, targetVersion) {
  const executable = join(workingRoot, "omp-desktop-updater-e2e.AppImage")
  await copyFile(baseAppImage, executable)
  await chmod(executable, 0o755)
  const child = spawn(
    executable,
    [`--updater-e2e-marker=${marker}`, `--updater-e2e-target=${targetVersion}`],
    { detached: false, stdio: "ignore" },
  )
  child.unref()
}


async function main() {
  const baseDirectory = process.env.E2E_BASE_DIR
  const targetDirectory = process.env.E2E_TARGET_DIR
  const targetVersion = process.env.E2E_TARGET_VERSION
  const baseVersion = process.env.E2E_BASE_VERSION
  const workingDirectory = process.env.E2E_WORK_DIR
  if (!baseDirectory || !targetDirectory || !targetVersion || !baseVersion || !workingDirectory) {
    throw new Error(
      "E2E_BASE_DIR, E2E_TARGET_DIR, E2E_BASE_VERSION, E2E_TARGET_VERSION, and E2E_WORK_DIR are required",
    )
  }

  const baseFiles = await filesRecursively(baseDirectory)
  const targetFiles = await filesRecursively(targetDirectory)
  const isWindows = process.platform === "win32"
  const assetPattern = isWindows ? /-setup\.exe$/i : /\.AppImage$/
  const baseAsset = singleFile(baseFiles, (path) => assetPattern.test(path), "base updater asset")
  const targetAsset = singleFile(targetFiles, (path) => assetPattern.test(path), "target updater asset")
  const targetSignature = singleFile(
    targetFiles,
    (path) => path === `${targetAsset}.sig`,
    "target updater signature",
  )
  const signature = await readFile(targetSignature, "utf8")
  const assetUrl = `http://${HOST}:${PORT}/target/${encodeURIComponent(basename(targetAsset))}`
  const manifest = buildUpdaterManifest({
    platform: process.platform,
    signature,
    targetVersion,
    assetUrl,
  })
  await mkdir(workingDirectory, { recursive: true })
  const marker = resolve(workingDirectory, "updater-events.jsonl")
  await rm(marker, { force: true })
  const { server } = await startUpdateServer(manifest, targetAsset)
  let installDirectory
  try {
    if (isWindows) {
      installDirectory = await launchWindowsBase(
        baseAsset,
        workingDirectory,
        marker,
        targetVersion,
      )
    } else {
      await launchLinuxBase(baseAsset, workingDirectory, marker, targetVersion)
    }
    const events = await waitForCompletion(marker, baseVersion, targetVersion, DEFAULT_TIMEOUT_MS)
    process.stdout.write(`${JSON.stringify(events)}\n`)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    if (installDirectory) {
      const installedFiles = await filesRecursively(installDirectory).catch(() => [])
      const uninstaller = installedFiles.find(
        (path) => basename(path).toLowerCase() === "uninstall.exe",
      )
      if (uninstaller) await runProcess(uninstaller, ["/S"]).catch(() => undefined)
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}

import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function checksumEntries(path) {
  const entries = new Map()
  const text = await readFile(path, "utf8")
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line)
    requireCondition(match, `Invalid checksum line ${index + 1} in ${basename(path)}`)
    const name = basename(match[2].replaceAll("\\", "/"))
    requireCondition(!entries.has(name), `Duplicate checksum entry for ${name}`)
    entries.set(name, match[1].toLowerCase())
  }
  return entries
}

async function verifyChecksums(directory, checksumName, installerNames) {
  const entries = await checksumEntries(join(directory, checksumName))
  for (const name of installerNames) {
    requireCondition(entries.has(name), `${checksumName} does not cover ${name}`)
    const actual = await sha256(join(directory, name))
    requireCondition(entries.get(name) === actual, `SHA-256 mismatch for ${name}`)
  }
}

function updaterAssetName(url, tag) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Updater URL is invalid: ${url}`)
  }
  const decodedPath = decodeURIComponent(parsed.pathname)
  requireCondition(
    decodedPath.includes(`/releases/download/${tag}/`),
    `Updater URL does not target ${tag}: ${url}`,
  )
  return basename(decodedPath)
}

export async function verifyReleaseAssets({ directory, tag, version }) {
  requireCondition(directory, "Release asset directory is required")
  requireCondition(version, "Release version is required")
  requireCondition(tag === `v${version}`, `Release tag ${tag} does not match version ${version}`)

  const names = (await readdir(directory)).sort()
  const files = new Set()
  for (const name of names) {
    if ((await stat(join(directory, name))).isFile()) files.add(name)
  }

  for (const required of ["latest.json", "SHA256SUMS-linux.txt", "SHA256SUMS-windows.txt"]) {
    requireCondition(files.has(required), `Required release asset is missing: ${required}`)
  }

  const linuxInstallers = names.filter((name) => /\.(?:appimage|deb|rpm)$/i.test(name))
  const windowsInstallers = names.filter((name) => /(?:setup\.exe|\.msi)$/i.test(name))
  requireCondition(linuxInstallers.length > 0, "No Linux installer is present")
  requireCondition(windowsInstallers.length > 0, "No Windows installer is present")

  for (const name of [...linuxInstallers, ...windowsInstallers]) {
    const signature = `${name}.sig`
    requireCondition(files.has(signature), `Updater signature is missing: ${signature}`)
    requireCondition(
      (await stat(join(directory, signature))).size > 0,
      `Updater signature is empty: ${signature}`,
    )
  }

  await verifyChecksums(directory, "SHA256SUMS-linux.txt", linuxInstallers)
  await verifyChecksums(directory, "SHA256SUMS-windows.txt", windowsInstallers)

  const updater = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"))
  requireCondition(
    updater.version === version,
    `latest.json version ${updater.version} does not match ${version}`,
  )
  requireCondition(
    updater.platforms && typeof updater.platforms === "object",
    "latest.json has no platforms",
  )
  const platformEntries = Object.entries(updater.platforms)
  requireCondition(
    platformEntries.some(([platform]) => platform.toLowerCase().includes("linux")),
    "latest.json has no Linux target",
  )
  requireCondition(
    platformEntries.some(([platform]) => platform.toLowerCase().includes("windows")),
    "latest.json has no Windows target",
  )
  for (const [platform, entry] of platformEntries) {
    requireCondition(entry && typeof entry === "object", `Invalid updater entry for ${platform}`)
    requireCondition(
      typeof entry.signature === "string" && entry.signature.trim(),
      `Missing updater signature for ${platform}`,
    )
    const assetName = updaterAssetName(entry.url, tag)
    requireCondition(
      files.has(assetName),
      `Updater target is missing for ${platform}: ${assetName}`,
    )
    requireCondition(
      files.has(`${assetName}.sig`),
      `Updater signature asset is missing for ${platform}`,
    )
  }

  return {
    linuxInstallers,
    windowsInstallers,
    signedInstallers: linuxInstallers.length + windowsInstallers.length,
    updaterTargets: platformEntries.length,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const summary = await verifyReleaseAssets({
      directory: process.argv[2] ?? process.env.RELEASE_DIR,
      tag: process.env.RELEASE_TAG,
      version: process.env.RELEASE_VERSION,
    })
    console.log(`Verified release assets: ${JSON.stringify(summary)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

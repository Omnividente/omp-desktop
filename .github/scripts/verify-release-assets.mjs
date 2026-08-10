import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function sha256(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function fileNames(directory) {
  const files = []
  for (const name of (await readdir(directory)).sort()) {
    if ((await stat(join(directory, name))).isFile()) files.push(name)
  }
  return files
}

function classifyInstallers(names) {
  return {
    linuxInstallers: names.filter((name) => /\.(?:appimage|deb|rpm)$/i.test(name)),
    windowsInstallers: names.filter((name) => /(?:setup\.exe|\.msi)$/i.test(name)),
  }
}

function requireInstallerCoverage({ linuxInstallers, windowsInstallers }) {
  const required = [
    ["AppImage", linuxInstallers, /\.appimage$/i],
    ["DEB", linuxInstallers, /\.deb$/i],
    ["RPM", linuxInstallers, /\.rpm$/i],
    ["NSIS", windowsInstallers, /setup\.exe$/i],
    ["MSI", windowsInstallers, /\.msi$/i],
  ]
  for (const [label, names, pattern] of required) {
    requireCondition(
      names.some((name) => pattern.test(name)),
      `No ${label} installer is present`,
    )
  }
}

function versionPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[^0-9A-Za-z])${escaped}(?:[^0-9A-Za-z]|$)`)
}

async function checksumContent(directory, names) {
  const lines = await Promise.all(
    names.map(async (name) => `${await sha256(join(directory, name))}  ${name}`),
  )
  return `${lines.join("\n")}\n`
}

export async function writeReleaseChecksums({ directory }) {
  requireCondition(directory, "Release asset directory is required")
  const { linuxInstallers, windowsInstallers } = classifyInstallers(await fileNames(directory))
  requireInstallerCoverage({ linuxInstallers, windowsInstallers })

  await Promise.all([
    writeFile(
      join(directory, "SHA256SUMS-linux.txt"),
      await checksumContent(directory, linuxInstallers),
    ),
    writeFile(
      join(directory, "SHA256SUMS-windows.txt"),
      await checksumContent(directory, windowsInstallers),
    ),
  ])

  return { linuxInstallers, windowsInstallers }
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

function normalizedUrl(value, label) {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    throw new Error(`${label} is invalid: ${value}`)
  }
}

export function requireDraftRelease({ releaseMetadata, tag }) {
  requireCondition(
    releaseMetadata && typeof releaseMetadata === "object",
    "Release metadata is required",
  )
  requireCondition(
    releaseMetadata.tag_name === tag,
    `Release metadata tag ${releaseMetadata.tag_name} does not match ${tag}`,
  )
  requireCondition(releaseMetadata.draft === true, `Release ${tag} is already published`)
}

function releaseAssetUrls(releaseMetadata, tag, repository) {
  requireDraftRelease({ releaseMetadata, tag })
  requireCondition(Array.isArray(releaseMetadata.assets), "Release metadata has no assets")

  const apiPath = `/repos/${repository}/releases/assets/`
  const downloadPath = `/${repository}/releases/download/${tag}/`
  const urls = new Map()
  for (const asset of releaseMetadata.assets) {
    requireCondition(
      asset && typeof asset.name === "string" && asset.name,
      "Release metadata contains an unnamed asset",
    )
    const candidates = [asset.url, asset.browser_download_url].filter(
      (candidate) => typeof candidate === "string" && candidate,
    )
    requireCondition(candidates.length > 0, `Release asset ${asset.name} has no URL`)
    for (const candidate of candidates) {
      const normalized = normalizedUrl(candidate, "Release asset URL")
      const pathname = new URL(normalized).pathname
      requireCondition(
        pathname.includes(apiPath) || pathname.includes(downloadPath),
        `Release asset ${asset.name} is outside ${repository} ${tag}`,
      )
      const existing = urls.get(normalized)
      requireCondition(
        existing === undefined || existing === asset.name,
        `Release metadata maps ${normalized} to multiple assets`,
      )
      urls.set(normalized, asset.name)
    }
  }
  return urls
}

function updaterAssetName(url, assetUrls, tag) {
  requireCondition(typeof url === "string" && url, "Updater URL is missing")
  const assetName = assetUrls.get(normalizedUrl(url, "Updater URL"))
  requireCondition(assetName, `Updater URL is not an asset of ${tag}: ${url}`)
  return assetName
}

export async function verifyReleaseAssets({
  directory,
  tag,
  version,
  repository,
  releaseMetadata,
}) {
  requireCondition(directory, "Release asset directory is required")
  requireCondition(version, "Release version is required")
  requireCondition(repository, "Release repository is required")
  requireCondition(tag === `v${version}`, `Release tag ${tag} does not match version ${version}`)

  const names = await fileNames(directory)
  const files = new Set(names)
  const assetUrls = releaseAssetUrls(releaseMetadata, tag, repository)

  for (const required of ["latest.json", "SHA256SUMS-linux.txt", "SHA256SUMS-windows.txt"]) {
    requireCondition(files.has(required), `Required release asset is missing: ${required}`)
  }

  const { linuxInstallers, windowsInstallers } = classifyInstallers(names)
  requireInstallerCoverage({ linuxInstallers, windowsInstallers })
  const allInstallers = [...linuxInstallers, ...windowsInstallers]
  const currentVersion = versionPattern(version)

  for (const name of allInstallers) {
    requireCondition(
      currentVersion.test(name),
      `Installer ${name} does not match release version ${version}`,
    )
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
  const installerSet = new Set(allInstallers)
  const updaterAssets = new Set()
  for (const [platform, entry] of platformEntries) {
    requireCondition(entry && typeof entry === "object", `Invalid updater entry for ${platform}`)
    requireCondition(
      typeof entry.signature === "string" && entry.signature.trim(),
      `Missing updater signature for ${platform}`,
    )
    const assetName = updaterAssetName(entry.url, assetUrls, tag)
    requireCondition(
      installerSet.has(assetName),
      `Updater target is not a supported installer for ${platform}: ${assetName}`,
    )
    updaterAssets.add(assetName)
    requireCondition(
      files.has(assetName),
      `Updater target is missing for ${platform}: ${assetName}`,
    )
    const signatureName = `${assetName}.sig`
    requireCondition(files.has(signatureName), `Updater signature asset is missing for ${platform}`)
    const uploadedSignature = (await readFile(join(directory, signatureName), "utf8")).trim()
    requireCondition(
      entry.signature.trim() === uploadedSignature,
      `latest.json signature does not match ${signatureName} for ${platform}`,
    )
  }
  for (const name of allInstallers) {
    requireCondition(updaterAssets.has(name), `latest.json has no updater target for ${name}`)
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
    const writeChecksums = process.argv[2] === "--write-checksums"
    const directory = writeChecksums
      ? (process.argv[3] ?? process.env.RELEASE_DIR)
      : (process.argv[2] ?? process.env.RELEASE_DIR)
    if (writeChecksums) {
      const summary = await writeReleaseChecksums({ directory })
      console.log(`Wrote release checksums: ${JSON.stringify(summary)}`)
    } else {
      requireCondition(process.env.RELEASE_METADATA, "Release metadata path is required")
      const releaseMetadata = JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
      const summary = await verifyReleaseAssets({
        directory,
        tag: process.env.RELEASE_TAG,
        version: process.env.RELEASE_VERSION,
        repository: process.env.RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY,
        releaseMetadata,
      })
      console.log(`Verified release assets: ${JSON.stringify(summary)}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

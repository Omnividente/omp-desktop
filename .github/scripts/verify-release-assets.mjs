import { execFile } from "node:child_process"
import { createHash, createPublicKey, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function hashFile(path, algorithm) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest()
}

async function sha256(path) {
  return (await hashFile(path, "sha256")).toString("hex")
}

function decodeBase64(value, label) {
  requireCondition(typeof value === "string" && value.trim(), `${label} is required`)
  const encoded = value.trim()
  requireCondition(
    encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded),
    `${label} is not valid base64`,
  )
  const decoded = Buffer.from(encoded, "base64")
  requireCondition(decoded.toString("base64") === encoded, `${label} is not canonical base64`)
  return decoded
}

function decodeBase64Text(value, label) {
  const decoded = decodeBase64(value, label)
  const text = decoded.toString("utf8")
  requireCondition(Buffer.from(text, "utf8").equals(decoded), `${label} is not valid UTF-8`)
  return text
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

function decodeUpdaterPublicKey(encodedPublicKey) {
  const lines = decodeBase64Text(encodedPublicKey, "Updater public key").trimEnd().split(/\r?\n/)
  requireCondition(
    lines.length === 2 && lines[0].startsWith("untrusted comment:"),
    "Updater public key has an invalid Minisign envelope",
  )
  const payload = decodeBase64(lines[1], "Updater public key payload")
  requireCondition(payload.length === 42, "Updater public key payload must be 42 bytes")
  requireCondition(
    payload.subarray(0, 2).equals(Buffer.from("Ed")),
    "Updater public key uses an unsupported algorithm",
  )
  return {
    keyId: payload.subarray(2, 10),
    publicKey: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, payload.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  }
}

async function verifyUpdaterSignature({
  artifactPath,
  encodedSignature,
  signatureName,
  signingKey,
}) {
  const lines = decodeBase64Text(encodedSignature, `Updater signature ${signatureName}`)
    .trimEnd()
    .split(/\r?\n/)
  requireCondition(
    lines.length === 4 &&
      lines[0].startsWith("untrusted comment:") &&
      lines[2].startsWith("trusted comment: "),
    `Updater signature has an invalid Minisign envelope: ${signatureName}`,
  )
  const payload = decodeBase64(lines[1], `Updater signature payload ${signatureName}`)
  requireCondition(
    payload.length === 74,
    `Updater signature payload must be 74 bytes: ${signatureName}`,
  )
  requireCondition(
    payload.subarray(0, 2).equals(Buffer.from("ED")),
    `Updater signature uses an unsupported algorithm: ${signatureName}`,
  )
  requireCondition(
    payload.subarray(2, 10).equals(signingKey.keyId),
    `Updater signature key does not match configured public key: ${signatureName}`,
  )
  const signature = payload.subarray(10)
  const artifactDigest = await hashFile(artifactPath, "blake2b512")
  requireCondition(
    verify(null, artifactDigest, signingKey.publicKey, signature),
    `Updater signature is cryptographically invalid: ${signatureName}`,
  )
  const trustedComment = lines[2].slice("trusted comment: ".length)
  const globalSignature = decodeBase64(
    lines[3],
    `Updater trusted comment signature ${signatureName}`,
  )
  requireCondition(
    globalSignature.length === 64,
    `Updater trusted comment signature must be 64 bytes: ${signatureName}`,
  )
  requireCondition(
    verify(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
      signingKey.publicKey,
      globalSignature,
    ),
    `Updater trusted comment signature is cryptographically invalid: ${signatureName}`,
  )
}

async function fileNames(directory) {
  const files = []
  for (const name of (await readdir(directory)).sort()) {
    if ((await stat(join(directory, name))).isFile()) files.push(name)
  }
  return files
}

export function classifyReleaseAsset(name) {
  const lower = name.toLowerCase()
  const platform = /(?:setup\.exe|\.msi|\.nsis\.zip|\.msi\.zip)(?:\.sig)?$/.test(lower)
    ? "windows"
    : /(?:\.appimage|\.deb|\.rpm|\.tar\.gz)(?:\.sig)?$/.test(lower)
      ? "linux"
      : "metadata"
  const kind = lower.endsWith(".sig")
    ? "signature"
    : lower === "latest.json"
      ? "updater-manifest"
      : lower.startsWith("sha256sums-")
        ? "checksum"
        : /(?:\.nsis\.zip|\.msi\.zip|\.tar\.gz)$/.test(lower)
          ? "updater-bundle"
          : "installer"
  return { kind, platform }
}

export function releaseAssetContentType(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith(".json")) return "application/json"
  if (lower.endsWith(".txt") || lower.endsWith(".sig")) return "text/plain"
  if (lower.endsWith(".zip")) return "application/zip"
  if (lower.endsWith(".tar.gz")) return "application/gzip"
  return "application/octet-stream"
}

const RELEASE_ASSET_STAGE_PREFIX = "__omp_stage__"
const RELEASE_ASSET_STAGE_LABEL_PREFIX = "omp-stage-sha256:"

export function stagedReleaseAssetName(name) {
  requireCondition(typeof name === "string" && name, "Release asset name is required")
  requireCondition(
    !name.startsWith(RELEASE_ASSET_STAGE_PREFIX),
    `Release asset name uses the reserved staging prefix: ${name}`,
  )
  return `${RELEASE_ASSET_STAGE_PREFIX}${name}`
}

function stagedReleaseAssetOriginalName(name) {
  if (typeof name !== "string" || !name.startsWith(RELEASE_ASSET_STAGE_PREFIX)) return null
  const originalName = name.slice(RELEASE_ASSET_STAGE_PREFIX.length)
  requireCondition(originalName, `Staged release asset has no original name: ${name}`)
  return originalName
}

function releaseAssets(releaseMetadata) {
  requireCondition(
    releaseMetadata && typeof releaseMetadata === "object",
    "Release metadata is required",
  )
  requireCondition(Array.isArray(releaseMetadata.assets), "Release metadata has no assets")
  return releaseMetadata.assets
}

function releaseAssetNamed(releaseMetadata, name) {
  const matches = releaseAssets(releaseMetadata).filter((asset) => asset?.name === name)
  requireCondition(matches.length <= 1, `Expected at most one release asset named ${name}`)
  return matches[0] ?? null
}

function requireReleaseAssetId(asset, label) {
  requireCondition(
    Number.isSafeInteger(asset?.id) && asset.id > 0,
    `${label} has an invalid asset id`,
  )
  return asset.id
}

function requireReleaseAssetMatches(asset, { name, contentType, digest, label }) {
  requireCondition(asset && typeof asset === "object", `Release asset ${name} is missing`)
  requireCondition(asset.name === name, `Release asset name ${asset.name} does not match ${name}`)
  requireCondition(
    asset.content_type === contentType,
    `Release asset ${name} must use Content-Type ${contentType}, got ${asset.content_type ?? "missing"}`,
  )
  requireCondition(
    asset.digest === digest,
    `Release asset ${name} digest ${asset.digest ?? "missing"} does not match ${digest}`,
  )
  requireCondition(asset.state === "uploaded", `Release asset ${name} is not durably uploaded`)
  if (label !== undefined) {
    requireCondition(asset.label === label, `Release asset ${name} has an unexpected staging label`)
  }
  requireReleaseAssetId(asset, `Release asset ${name}`)
  return asset
}

function stagedReleaseAssetDigest(asset) {
  const label = asset?.label
  requireCondition(
    typeof label === "string" && label.startsWith(RELEASE_ASSET_STAGE_LABEL_PREFIX),
    `Staged release asset ${asset?.name ?? "unknown"} has no recovery digest`,
  )
  const digest = `sha256:${label.slice(RELEASE_ASSET_STAGE_LABEL_PREFIX.length)}`
  requireCondition(
    /^sha256:[0-9a-f]{64}$/.test(digest),
    `Staged release asset ${asset.name} has an invalid recovery digest`,
  )
  return digest
}

function requireReleaseAssetClient(client) {
  for (const method of ["loadRelease", "uploadAsset", "updateAsset", "deleteAsset"]) {
    requireCondition(
      typeof client?.[method] === "function",
      `Release asset client.${method} is required`,
    )
  }
}

async function deleteStageOnlyWhileOriginalExists(client, originalName, stageName) {
  const releaseMetadata = await client.loadRelease()
  const original = releaseAssetNamed(releaseMetadata, originalName)
  const staged = releaseAssetNamed(releaseMetadata, stageName)
  if (original && staged) {
    await client.deleteAsset(requireReleaseAssetId(staged, `Staged release asset ${stageName}`))
  }
}

export async function recoverStagedReleaseAssets({ client }) {
  requireReleaseAssetClient(client)
  const snapshot = await client.loadRelease()
  const stageNames = releaseAssets(snapshot)
    .map((asset) => asset?.name)
    .filter((name) => stagedReleaseAssetOriginalName(name) !== null)
  const recovered = []
  const cleaned = []

  for (const stageName of stageNames) {
    const originalName = stagedReleaseAssetOriginalName(stageName)
    const releaseMetadata = await client.loadRelease()
    const staged = releaseAssetNamed(releaseMetadata, stageName)
    if (!staged) continue
    const original = releaseAssetNamed(releaseMetadata, originalName)
    if (original) {
      await client.deleteAsset(requireReleaseAssetId(staged, `Staged release asset ${stageName}`))
      cleaned.push(originalName)
      continue
    }

    const digest = stagedReleaseAssetDigest(staged)
    const contentType = releaseAssetContentType(originalName)
    requireReleaseAssetMatches(staged, {
      name: stageName,
      contentType,
      digest,
      label: staged.label,
    })
    const promoted = await client.updateAsset(requireReleaseAssetId(staged, stageName), {
      name: originalName,
      label: "",
    })
    requireReleaseAssetMatches(promoted, { name: originalName, contentType, digest })
    recovered.push(originalName)
  }

  return { recovered, cleaned }
}

export async function replaceReleaseAssetSafely({ client, path, name, contentType }) {
  requireReleaseAssetClient(client)
  requireCondition(typeof path === "string" && path, "Release asset path is required")
  requireCondition(
    typeof contentType === "string" && contentType,
    "Release asset Content-Type is required",
  )
  const digestHex = await sha256(path)
  const digest = `sha256:${digestHex}`
  const stageName = stagedReleaseAssetName(name)
  const stageLabel = `${RELEASE_ASSET_STAGE_LABEL_PREFIX}${digestHex}`

  await recoverStagedReleaseAssets({ client })
  let releaseMetadata = await client.loadRelease()
  let original = releaseAssetNamed(releaseMetadata, name)
  if (
    original &&
    original.content_type === contentType &&
    original.digest === digest &&
    original.state === "uploaded"
  ) {
    return { status: "unchanged", assetId: requireReleaseAssetId(original, name) }
  }

  if (!original) {
    const created = await client.uploadAsset({ path, name, contentType, label: "" })
    requireReleaseAssetMatches(created, { name, contentType, digest })
    return { status: "created", assetId: created.id }
  }

  let staged
  try {
    staged = await client.uploadAsset({
      path,
      name: stageName,
      contentType,
      label: stageLabel,
    })
    requireReleaseAssetMatches(staged, {
      name: stageName,
      contentType,
      digest,
      label: stageLabel,
    })
  } catch (error) {
    try {
      await deleteStageOnlyWhileOriginalExists(client, name, stageName)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to stage ${name} and clean up its temporary asset`,
      )
    }
    throw error
  }

  let originalDeleted = false
  try {
    await client.deleteAsset(requireReleaseAssetId(original, `Release asset ${name}`))
    originalDeleted = true
    const promoted = await client.updateAsset(requireReleaseAssetId(staged, stageName), {
      name,
      label: "",
    })
    requireReleaseAssetMatches(promoted, { name, contentType, digest })
    return { status: "replaced", assetId: promoted.id }
  } catch (error) {
    if (!originalDeleted) {
      try {
        await deleteStageOnlyWhileOriginalExists(client, name, stageName)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to preserve ${name} after an interrupted replacement`,
        )
      }
    }
    throw error
  }
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
  const expectedNames = new Set(installerNames)
  for (const name of entries.keys()) {
    requireCondition(
      expectedNames.has(name),
      `${checksumName} contains an unexpected entry: ${name}`,
    )
  }
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

export function requireReleaseState({ releaseMetadata, tag, state }) {
  requireCondition(
    releaseMetadata && typeof releaseMetadata === "object",
    "Release metadata is required",
  )
  requireCondition(
    releaseMetadata.tag_name === tag,
    `Release metadata tag ${releaseMetadata.tag_name} does not match ${tag}`,
  )

  const expected = {
    draft: { draft: true },
    "draft-prerelease": { draft: true, prerelease: true },
    "candidate-prerelease": { draft: false, prerelease: true },
    stable: { draft: false, prerelease: false },
  }[state]
  requireCondition(expected, `Unknown release state: ${state}`)
  const stateError =
    state === "draft" && releaseMetadata.draft === false
      ? `Release ${tag} is already published`
      : `Release ${tag} is not in ${state} state`
  requireCondition(releaseMetadata.draft === expected.draft, stateError)
  if (expected.prerelease !== undefined) {
    requireCondition(
      releaseMetadata.prerelease === expected.prerelease,
      `Release ${tag} is not in ${state} state`,
    )
  }
}

export function requireDraftRelease({ releaseMetadata, tag }) {
  requireReleaseState({ releaseMetadata, tag, state: "draft" })
}

export function requireDraftPrerelease({ releaseMetadata, tag }) {
  requireReleaseState({ releaseMetadata, tag, state: "draft-prerelease" })
}

export function requireCandidatePrerelease({ releaseMetadata, tag }) {
  requireReleaseState({ releaseMetadata, tag, state: "candidate-prerelease" })
}

export function requireStableRelease({ releaseMetadata, tag }) {
  requireReleaseState({ releaseMetadata, tag, state: "stable" })
}

export function releasePublicationDisposition({ releaseMetadata, tag, expectedId }) {
  requireCondition(
    Number.isSafeInteger(expectedId) && expectedId > 0,
    `Expected release id is invalid: ${expectedId}`,
  )
  requireCondition(
    releaseMetadata?.id === expectedId,
    `Expected release ${expectedId} but resolved ${releaseMetadata?.id ?? "missing"}`,
  )
  if (releaseMetadata.draft === true) {
    requireDraftPrerelease({ releaseMetadata, tag })
    return "draft"
  }
  requireCandidatePrerelease({ releaseMetadata, tag })
  return "candidate"
}

export function selectDraftRelease({ releasePages, tag, allowMissing = false }) {
  requireCondition(Array.isArray(releasePages), "Paginated release metadata is required")
  const releases = releasePages.flatMap((page) => {
    requireCondition(Array.isArray(page), "Invalid release metadata page")
    return page
  })
  const matches = releases.filter(
    (release) => release && typeof release === "object" && release.tag_name === tag,
  )
  requireCondition(
    matches.length <= 1,
    `Expected at most one release for ${tag}, found ${matches.length}`,
  )
  if (matches.length === 0) {
    requireCondition(allowMissing, `Expected exactly one release for ${tag}, found 0`)
    return null
  }
  const release = matches[0]
  requireCondition(
    Number.isSafeInteger(release.id) && release.id > 0,
    `Release ${tag} has an invalid id`,
  )
  requireDraftRelease({ releaseMetadata: release, tag })
  return release
}

const DEFAULT_DRAFT_VISIBILITY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 16_000]

async function loadGitHubReleasePages(repository) {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  )
  return JSON.parse(stdout)
}

export async function waitForDraftRelease({
  loadReleasePages,
  tag,
  expectedId,
  delaysMs = DEFAULT_DRAFT_VISIBILITY_DELAYS_MS,
  wait = (delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)),
  onRetry = () => {},
}) {
  requireCondition(typeof loadReleasePages === "function", "Release page loader is required")
  requireCondition(typeof tag === "string" && tag, "Release tag is required")
  requireCondition(
    Number.isSafeInteger(expectedId) && expectedId > 0,
    `Expected release id is invalid: ${expectedId}`,
  )
  requireCondition(
    Array.isArray(delaysMs) && delaysMs.length > 0,
    "Draft visibility retry schedule is required",
  )

  for (const [index, delayMs] of delaysMs.entries()) {
    requireCondition(
      Number.isSafeInteger(delayMs) && delayMs >= 0,
      `Draft visibility retry delay is invalid: ${delayMs}`,
    )
    if (delayMs > 0) await wait(delayMs)
    const release = selectDraftRelease({
      releasePages: await loadReleasePages(),
      tag,
      allowMissing: true,
    })
    if (release) {
      requireCondition(
        release.id === expectedId,
        `Created release ${expectedId} but resolved ${release.id} for ${tag}`,
      )
      return release
    }
    const nextDelayMs = delaysMs[index + 1]
    if (nextDelayMs !== undefined) {
      onRetry({
        attempt: index + 1,
        totalAttempts: delaysMs.length,
        nextDelayMs,
      })
    }
  }

  throw new Error(
    `Created release ${expectedId} was not visible after ${delaysMs.length} attempts for ${tag}`,
  )
}

function releaseAssetUrls(releaseMetadata, tag, repository, state = "draft") {
  requireReleaseState({ releaseMetadata, tag, state })
  requireCondition(Array.isArray(releaseMetadata.assets), "Release metadata has no assets")

  const updaterManifests = releaseMetadata.assets.filter(
    (asset) => asset?.name?.toLowerCase() === "latest.json",
  )
  requireCondition(
    updaterManifests.length === 1,
    `Release ${tag} must contain exactly one latest.json asset`,
  )
  for (const asset of releaseMetadata.assets) {
    const expectedContentType = releaseAssetContentType(asset?.name ?? "")
    requireCondition(
      asset?.content_type === expectedContentType,
      `Release asset ${asset?.name ?? "unknown"} must use Content-Type ${expectedContentType}, got ${asset?.content_type ?? "missing"}`,
    )
  }

  const apiPath = `/repos/${repository}/releases/assets/`
  const downloadPath = `/${repository}/releases/download/`
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
        pathname.startsWith(apiPath) || pathname.startsWith(downloadPath),
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
  updaterPublicKey,
  releaseState = "draft",
}) {
  requireCondition(directory, "Release asset directory is required")
  requireCondition(version, "Release version is required")
  requireCondition(repository, "Release repository is required")
  requireCondition(tag === `v${version}`, `Release tag ${tag} does not match version ${version}`)
  const signingKey = decodeUpdaterPublicKey(updaterPublicKey)

  const names = await fileNames(directory)
  const files = new Set(names)
  const assetUrls = releaseAssetUrls(releaseMetadata, tag, repository, releaseState)

  for (const required of ["latest.json", "SHA256SUMS-linux.txt", "SHA256SUMS-windows.txt"]) {
    requireCondition(files.has(required), `Required release asset is missing: ${required}`)
  }

  const { linuxInstallers, windowsInstallers } = classifyInstallers(names)
  requireInstallerCoverage({ linuxInstallers, windowsInstallers })
  const allInstallers = [...linuxInstallers, ...windowsInstallers]
  const currentVersion = versionPattern(version)
  const uploadedSignatures = new Map()

  for (const name of allInstallers) {
    requireCondition(
      currentVersion.test(name),
      `Installer ${name} does not match release version ${version}`,
    )
    const signatureName = `${name}.sig`
    requireCondition(files.has(signatureName), `Updater signature is missing: ${signatureName}`)
    requireCondition(
      (await stat(join(directory, signatureName))).size > 0,
      `Updater signature is empty: ${signatureName}`,
    )
    const encodedSignature = (await readFile(join(directory, signatureName), "utf8")).trim()
    await verifyUpdaterSignature({
      artifactPath: join(directory, name),
      encodedSignature,
      signatureName,
      signingKey,
    })
    uploadedSignatures.set(name, encodedSignature)
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
    const uploadedSignature = uploadedSignatures.get(assetName)
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
    verifiedSignatures: allInstallers.length,
    updaterTargets: platformEntries.length,
  }
}
async function verifyCliReleaseAssets({ directory, releaseState }) {
  requireCondition(process.env.RELEASE_METADATA, "Release metadata path is required")
  const releaseMetadata = JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
  const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"))
  const summary = await verifyReleaseAssets({
    directory,
    tag: process.env.RELEASE_TAG,
    version: process.env.RELEASE_VERSION,
    repository: process.env.RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY,
    releaseMetadata,
    updaterPublicKey: tauriConfig.plugins?.updater?.pubkey,
    releaseState,
  })
  console.log(`Verified ${releaseState} release assets: ${JSON.stringify(summary)}`)
}

function parseGhJson(stdout, label) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function releaseIdFromEnvironment() {
  const text = process.env.RELEASE_ID?.trim() ?? ""
  const releaseId = Number(text)
  requireCondition(
    Number.isSafeInteger(releaseId) && releaseId > 0 && String(releaseId) === text,
    `Release id is invalid: ${text}`,
  )
  return releaseId
}

function githubReleaseAssetClient({ repository, releaseId }) {
  requireCondition(typeof repository === "string" && repository, "GitHub repository is required")
  const releasePath = `repos/${repository}/releases/${releaseId}`
  const assetPath = (assetId) => `repos/${repository}/releases/assets/${assetId}`
  const ghJson = async (args, label, timeout = 60_000) => {
    const { stdout } = await execFileAsync("gh", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    })
    return parseGhJson(stdout, label)
  }
  return {
    loadRelease: () => ghJson(["api", releasePath], "Release metadata request"),
    uploadAsset: async ({ path, name, contentType, label }) => {
      const releaseMetadata = await ghJson(["api", releasePath], "Release metadata request")
      const uploadBase = releaseMetadata.upload_url?.split("{")[0]
      requireCondition(uploadBase, "Release metadata has no upload URL")
      const query = new URLSearchParams({ name })
      if (label) query.set("label", label)
      return ghJson(
        [
          "api",
          "--method",
          "POST",
          "--header",
          `Content-Type: ${contentType}`,
          "--input",
          path,
          `${uploadBase}?${query}`,
        ],
        `Release asset upload ${name}`,
        10 * 60_000,
      )
    },
    updateAsset: (assetId, { name, label }) =>
      ghJson(
        [
          "api",
          "--method",
          "PATCH",
          assetPath(assetId),
          "--raw-field",
          `name=${name}`,
          "--raw-field",
          `label=${label ?? ""}`,
        ],
        `Release asset update ${name}`,
      ),
    deleteAsset: async (assetId) => {
      await execFileAsync("gh", ["api", "--method", "DELETE", assetPath(assetId), "--silent"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      })
    },
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const mode = process.argv[2]
    if (mode === "--content-type") {
      const name = process.argv[3]
      requireCondition(name, "Release asset name is required")
      console.log(releaseAssetContentType(name))
    } else if (mode === "--publication-state") {
      requireCondition(process.env.RELEASE_METADATA, "Release metadata path is required")
      requireCondition(process.env.RELEASE_TAG, "Release tag is required")
      const releaseMetadata = JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
      const expectedId = releaseIdFromEnvironment()
      console.log(
        releasePublicationDisposition({
          releaseMetadata,
          tag: process.env.RELEASE_TAG,
          expectedId,
        }),
      )
    } else if (mode === "--recover-staged-assets" || mode === "--replace-asset") {
      const releaseId = releaseIdFromEnvironment()
      const client = githubReleaseAssetClient({
        repository: process.env.GITHUB_REPOSITORY,
        releaseId,
      })
      if (mode === "--recover-staged-assets") {
        const summary = await recoverStagedReleaseAssets({ client })
        console.log(`Recovered staged release assets: ${JSON.stringify(summary)}`)
      } else {
        const [path, name, contentType] = process.argv.slice(3)
        const summary = await replaceReleaseAssetSafely({ client, path, name, contentType })
        console.log(`Replaced release asset safely: ${JSON.stringify({ name, ...summary })}`)
      }
    } else if (mode === "--select-draft") {
      requireCondition(process.env.RELEASE_LIST, "Paginated release metadata path is required")
      requireCondition(process.env.RELEASE_TAG, "Release tag is required")
      const releasePages = JSON.parse(await readFile(process.env.RELEASE_LIST, "utf8"))
      const release = selectDraftRelease({
        releasePages,
        tag: process.env.RELEASE_TAG,
        allowMissing: process.env.ALLOW_MISSING_RELEASE === "true",
      })
      console.log(release ? String(release.id) : "none")
    } else if (mode === "--wait-for-draft") {
      requireCondition(process.env.GITHUB_REPOSITORY, "GitHub repository is required")
      requireCondition(process.env.RELEASE_TAG, "Release tag is required")
      const expectedIdText = process.env.EXPECTED_RELEASE_ID?.trim() ?? ""
      const expectedId = Number(expectedIdText)
      requireCondition(
        Number.isSafeInteger(expectedId) && expectedId > 0 && String(expectedId) === expectedIdText,
        `Expected release id is invalid: ${expectedIdText}`,
      )
      const release = await waitForDraftRelease({
        loadReleasePages: () => loadGitHubReleasePages(process.env.GITHUB_REPOSITORY),
        tag: process.env.RELEASE_TAG,
        expectedId,
        onRetry: ({ attempt, totalAttempts, nextDelayMs }) => {
          console.error(
            `Draft ${process.env.RELEASE_TAG} is not visible after attempt ${attempt}/${totalAttempts}; retrying in ${nextDelayMs} ms`,
          )
        },
      })
      console.log(String(release.id))
    } else if (
      mode === "--require-draft" ||
      mode === "--require-draft-prerelease" ||
      mode === "--require-candidate-prerelease" ||
      mode === "--require-stable"
    ) {
      requireCondition(process.env.RELEASE_METADATA, "Release metadata path is required")
      requireCondition(process.env.RELEASE_TAG, "Release tag is required")
      const releaseMetadata = JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
      const stateByMode = {
        "--require-draft": "draft",
        "--require-draft-prerelease": "draft-prerelease",
        "--require-candidate-prerelease": "candidate-prerelease",
        "--require-stable": "stable",
      }
      const releaseState = stateByMode[mode]
      requireReleaseState({ releaseMetadata, tag: process.env.RELEASE_TAG, state: releaseState })
      console.log(`Verified ${releaseState} release ${process.env.RELEASE_TAG}`)
    } else if (mode === "--verify-candidate-prerelease" || mode === "--verify-stable") {
      const directory = process.argv[3] ?? process.env.RELEASE_DIR
      await verifyCliReleaseAssets({
        directory,
        releaseState: mode === "--verify-candidate-prerelease" ? "candidate-prerelease" : "stable",
      })
    } else if (mode === "--write-checksums") {
      const directory = process.argv[3] ?? process.env.RELEASE_DIR
      const summary = await writeReleaseChecksums({ directory })
      console.log(`Wrote release checksums: ${JSON.stringify(summary)}`)
    } else {
      const directory = process.argv[2] ?? process.env.RELEASE_DIR
      await verifyCliReleaseAssets({ directory, releaseState: "draft" })
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

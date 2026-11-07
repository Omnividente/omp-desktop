import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { classifyReleaseAsset, verifyReleaseAssets } from "./verify-release-assets.mjs"

const execFileAsync = promisify(execFile)
const repository = "Omnividente/omp-desktop"
const apiRoot = `https://api.github.com/repos/${repository}`
const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const targetRoot = resolve(process.cwd())
const baseIdentity = {
  tag: "v0.9.10",
  version: "0.9.10",
  commit: "73e661504b3d3d0a4b382e3289b02355b7400699",
  tagObjectSha: "b901b14eaf5f13c23e33d9ba84dd31b62d02a540",
  releaseId: 413772482,
}
const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`
const manifestName = "release-assets-manifest.json"
let stage = "inputs"
let evidenceDir
let mode = "prepare"

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function requireEqual(actual, expected, label) {
  requireCondition(
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)),
    `${label} changed or does not match`,
  )
}

function positiveId(value, label) {
  requireCondition(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  )
  return value
}

function inputId(name) {
  const value = process.env[name] ?? ""
  requireCondition(/^[1-9][0-9]*$/.test(value), `${name} is required as an exact numeric ID`)
  return positiveId(Number(value), name)
}

function inside(path, root) {
  const part = relative(root, path)
  return (
    part === "" ||
    (part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part))
  )
}

async function jsonEvidence(name, value) {
  await writeFile(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
}

// Never pass credentials to subprocesses, download redirects, error output or evidence.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|TEMP|TMP|LANG|LC_ALL)$/i.test(key),
  ),
)

async function git(cwd, ...args) {
  try {
    return (
      await execFileAsync("git", ["--no-optional-locks", ...args], {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout
  } catch {
    throw new Error("Read-only checkout identity verification failed")
  }
}

async function api(path) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  // contents:read intentionally grants no actions:read. Public production run/job
  // metadata is readable anonymously; do not send a narrower token to that API.
  if (process.env.GH_TOKEN && !path.startsWith("/actions/"))
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
  let response
  try {
    response = await fetch(`${apiRoot}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new Error(`GitHub read-only request failed: ${path}`)
  }
  requireCondition(
    response.ok,
    `GitHub read-only request returned HTTP ${response.status}: ${path}`,
  )
  try {
    return await response.json()
  } catch {
    throw new Error(`GitHub returned invalid JSON: ${path}`)
  }
}

async function pages(path, key) {
  const rows = []
  for (let page = 1; ; page += 1) {
    const result = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    const entries = key ? result[key] : result
    requireCondition(Array.isArray(entries), `Invalid paginated inventory: ${path}`)
    rows.push(...entries)
    if (entries.length < 100) return rows
  }
}

function assetInventory(assets, identity) {
  requireCondition(
    Array.isArray(assets) && assets.length > 0,
    `${identity.tag} has no asset inventory`,
  )
  const ids = new Set()
  const names = new Set()
  return assets
    .map((asset) => {
      positiveId(asset.id, "Asset ID")
      positiveId(asset.size, "Asset size")
      requireCondition(
        typeof asset.name === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(asset.name) &&
          !asset.name.includes("..") &&
          !asset.name.startsWith("__omp_stage__") &&
          !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(asset.name) &&
          !asset.name.endsWith("."),
        "Unsafe release asset name",
      )
      requireCondition(
        !ids.has(asset.id) && !names.has(asset.name.toLowerCase()),
        "Duplicate asset ID or portable filename",
      )
      ids.add(asset.id)
      names.add(asset.name.toLowerCase())
      requireCondition(asset.state === "uploaded", `Asset is not uploaded: ${asset.name}`)
      requireCondition(
        typeof asset.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(asset.digest),
        `Missing SHA-256 digest: ${asset.name}`,
      )
      requireCondition(
        asset.url === `${apiRoot}/releases/assets/${asset.id}`,
        `Wrong API asset URL: ${asset.name}`,
      )
      requireCondition(
        asset.browser_download_url ===
          `https://github.com/${repository}/releases/download/${identity.tag}/${encodeURIComponent(asset.name)}`,
        `Wrong browser asset URL: ${asset.name}`,
      )
      requireCondition(
        typeof asset.content_type === "string" &&
          asset.content_type.length > 0 &&
          typeof asset.updated_at === "string" &&
          typeof asset.created_at === "string",
        `Incomplete asset metadata: ${asset.name}`,
      )
      // Download count necessarily changes when these bytes are fetched. Every other
      // metadata field (including unknown future fields) is frozen, not just the hash.
      const { download_count, ...frozen } = asset
      return frozen
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

function releaseIdentity(release, identity, prerelease) {
  requireCondition(
    release.id === identity.releaseId && release.tag_name === identity.tag,
    "Release ID/tag binding mismatch",
  )
  requireCondition(
    release.draft === false &&
      release.prerelease === prerelease &&
      release.immutable === true &&
      typeof release.published_at === "string",
    `Release state is not immutable/public: ${identity.tag}`,
  )
  requireCondition(
    release.url === `${apiRoot}/releases/${identity.releaseId}` &&
      release.assets_url === `${apiRoot}/releases/${identity.releaseId}/assets` &&
      release.html_url === `https://github.com/${repository}/releases/tag/${identity.tag}`,
    "Release repository binding mismatch",
  )
  requireCondition(
    typeof release.target_commitish === "string" && release.target_commitish.length > 0,
    "Release target_commitish is missing",
  )
  if (/^[0-9a-f]{40}$/i.test(release.target_commitish)) {
    requireCondition(
      release.target_commitish === identity.commit,
      "Release target_commitish SHA mismatch",
    )
  }
}

async function releaseSnapshot(identity, prerelease, releaseList) {
  const release = await api(`/releases/${identity.releaseId}`)
  const byTag = await api(`/releases/tags/${identity.tag}`)
  releaseIdentity(release, identity, prerelease)
  releaseIdentity(byTag, identity, prerelease)
  requireCondition(
    releaseList.filter((item) => item.tag_name === identity.tag).length === 1 &&
      releaseList.find((item) => item.tag_name === identity.tag)?.id === identity.releaseId,
    "Release tag is missing or duplicated",
  )
  const assets = assetInventory(await pages(`/releases/${identity.releaseId}/assets`), identity)
  requireEqual(
    assetInventory(release.assets, identity),
    assets,
    "Embedded and paginated release inventory",
  )
  requireEqual(assetInventory(byTag.assets, identity), assets, "ID and tag release inventory")
  const { assets: embedded, ...fields } = release
  const { assets: tagged, ...tagFields } = byTag
  requireEqual(fields, tagFields, "ID and tag release metadata")
  const ref = await api(`/git/ref/tags/${identity.tag}`)
  requireCondition(
    ref.ref === `refs/tags/${identity.tag}` &&
      ref.object?.type === "tag" &&
      /^[0-9a-f]{40}$/.test(ref.object.sha),
    "Release tag must be an annotated tag",
  )
  const tag = await api(`/git/tags/${ref.object.sha}`)
  requireCondition(
    tag.sha === ref.object.sha &&
      tag.tag === identity.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === identity.commit &&
      tag.verification?.verified === true &&
      tag.verification.reason === "valid",
    "Signed tag/commit verification failed",
  )
  if (identity.tagObjectSha)
    requireCondition(tag.sha === identity.tagObjectSha, "Pinned tag object mismatch")
  return { release: { ...fields, assets }, ref, tag }
}

async function snapshot(target) {
  const releases = await pages("/releases")
  const releaseIds = releases.map((release) => positiveId(release.id, "Release ID"))
  requireCondition(
    new Set(releaseIds).size === releaseIds.length,
    "Duplicate release IDs across pages",
  )
  const base = await releaseSnapshot(baseIdentity, false, releases)
  const candidate = await releaseSnapshot(target, true, releases)
  const allAssetIds = [...base.release.assets, ...candidate.release.assets].map((asset) => asset.id)
  requireCondition(
    new Set(allAssetIds).size === allAssetIds.length,
    "Base and target share asset IDs",
  )
  const latest = await api("/releases/latest")
  releaseIdentity(latest, baseIdentity, false)
  requireEqual(
    assetInventory(latest.assets, baseIdentity),
    base.release.assets,
    "Latest/base asset inventory",
  )
  const run = await api(`/actions/runs/${target.releaseRunId}`)
  requireCondition(
    run.id === target.releaseRunId &&
      run.path === ".github/workflows/release-artifacts.yml" &&
      run.event === "push" &&
      run.head_sha === target.commit &&
      run.head_branch === target.tag &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.repository?.private === false &&
      run.html_url === `https://github.com/${repository}/actions/runs/${target.releaseRunId}`,
    "Production run/source binding failed",
  )
  const jobs = await pages(`/actions/runs/${target.releaseRunId}/jobs?filter=latest`, "jobs")
  for (const name of [
    "Validate release tag",
    "Prepare unique draft release",
    "Build and upload (ubuntu-22.04)",
    "Build and upload (windows-latest)",
    "Publish public candidate prerelease",
  ]) {
    const matching = jobs.filter((job) => job.name === name)
    requireCondition(
      matching.length === 1 &&
        matching[0].head_sha === target.commit &&
        matching[0].status === "completed" &&
        matching[0].conclusion === "success",
      `Required production job did not succeed: ${name}`,
    )
  }
  requireCondition(
    jobs.every(
      (job) => job.status === "completed" && ["success", "skipped"].includes(job.conclusion),
    ),
    "Production run has an unsuccessful job",
  )
  const comparison = await api(`/compare/${target.commit}...main`)
  requireCondition(
    ["ahead", "identical"].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === target.commit,
    "Target commit is not reachable from main",
  )
  return {
    repository,
    base,
    target: candidate,
    run,
    jobs,
    latest: {
      id: latest.id,
      tag: latest.tag_name,
      immutable: latest.immutable,
      publishedAt: latest.published_at,
    },
  }
}

async function checkCheckout(targetSha) {
  requireCondition(
    (await git(targetRoot, "rev-parse", "HEAD")).trim() === targetSha,
    "Production checkout HEAD is not PRODUCTION_TARGET_SHA",
  )
  const harnessSha = (await git(harnessRoot, "rev-parse", "HEAD")).trim()
  if (process.env.GITHUB_ACTIONS === "true") {
    requireCondition(
      process.env.GITHUB_REPOSITORY === repository &&
        /^[0-9a-f]{40}$/.test(process.env.PRODUCTION_HARNESS_SHA ?? "") &&
        process.env.PRODUCTION_HARNESS_SHA === harnessSha &&
        process.env.GITHUB_SHA === harnessSha &&
        process.env.GITHUB_WORKFLOW_SHA === harnessSha &&
        process.env.GITHUB_WORKFLOW_REF?.startsWith(
          `${repository}/.github/workflows/production-install-smoke.yml@`,
        ),
      "Dispatch/workflow source SHA does not match signed acceptance harness",
    )
  }
  // Bind both the production inputs and every executed helper/config byte.
  for (const [root, sha] of [
    [targetRoot, targetSha],
    [harnessRoot, harnessSha],
  ]) {
    for (const path of [
      ".github/scripts/prepare-production-assets.mjs",
      ".github/scripts/verify-release-assets.mjs",
      ".github/scripts/run-production-windows-smoke.mjs",
      ".github/workflows/production-install-smoke.yml",
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
    ]) {
      const checkedOut = (await readFile(join(root, path), "utf8")).replaceAll("\r\n", "\n")
      const committed = (await git(root, "show", `${sha}:${path}`)).replaceAll("\r\n", "\n")
      requireCondition(
        checkedOut === committed,
        `Checkout file differs from pinned commit: ${path}`,
      )
    }
  }
  const verifier = ".github/scripts/verify-release-assets.mjs"
  const verifierSha256 = await hashFile(join(targetRoot, verifier))
  requireCondition(
    verifierSha256 === (await hashFile(join(harnessRoot, verifier))),
    "Cryptographic verifier bytes differ from immutable production source",
  )
  await jsonEvidence(`acquisition-source-${mode}.json`, {
    production: { commit: targetSha, root: targetRoot },
    harness: { commit: harnessSha, root: harnessRoot },
    verifierSha256,
  })
}

async function productionKey() {
  const config = JSON.parse(await readFile(join(targetRoot, "src-tauri/tauri.conf.json"), "utf8"))
  const packageManifest = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8"))
  const cargo = await readFile(join(targetRoot, "src-tauri/Cargo.toml"), "utf8")
  requireCondition(
    config.version === "0.9.11" &&
      packageManifest.version === "0.9.11" &&
      cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] === "0.9.11",
    "Target source version mismatch",
  )
  const source = await api(`/contents/src-tauri/tauri.conf.json?ref=${baseIdentity.commit}`)
  requireCondition(
    source.encoding === "base64" && typeof source.content === "string",
    "Pinned base config is missing",
  )
  const baseConfig = JSON.parse(Buffer.from(source.content, "base64").toString("utf8"))
  requireCondition(
    baseConfig.version === baseIdentity.version,
    "Pinned base config version mismatch",
  )
  for (const item of [config, baseConfig]) {
    requireCondition(
      item.identifier === "com.ompdesk.desktop" &&
        typeof item.plugins?.updater?.pubkey === "string" &&
        item.plugins.updater.pubkey.trim().length > 0,
      "Production identity/public key is missing",
    )
    requireEqual(item.plugins.updater.endpoints, [endpoint], "Production updater endpoints")
  }
  requireCondition(
    config.plugins.updater.pubkey === baseConfig.plugins.updater.pubkey,
    "Production public key differs from pinned base",
  )
  await jsonEvidence("production-trust.json", {
    baseCommit: baseIdentity.commit,
    baseConfig,
    targetConfig: config,
  })
  return config.plugins.updater.pubkey
}

async function hashFile(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function download(asset, directory) {
  let url = asset.browser_download_url
  const signal = AbortSignal.timeout(300_000)
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const parsed = new URL(url)
      requireCondition(
        parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          [
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "github-releases.githubusercontent.com",
          ].includes(parsed.hostname),
        "Unsafe download redirect",
      )
      // Public release bytes never receive GH_TOKEN, even on the initial request.
      const response = await fetch(url, { redirect: "manual", signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        requireCondition(location, "Missing download redirect")
        url = new URL(location, url).href
        continue
      }
      requireCondition(response.status === 200 && response.body, "Asset download failed")
      const hash = createHash("sha256")
      let bytes = 0
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length
          if (bytes > asset.size) return callback(new Error("Asset exceeds frozen size"))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        createWriteStream(join(directory, asset.name), { flags: "wx" }),
        { signal },
      )
      requireCondition(
        bytes === asset.size && hash.digest("hex") === asset.digest.slice(7),
        "Asset bytes do not match frozen metadata",
      )
      return
    }
  } catch {
    // Fetch errors can contain signed redirect URLs. Do not expose them.
    throw new Error(`Immutable asset download/hash failed: ${asset.name}`)
  }
  throw new Error(`Too many asset download redirects: ${asset.name}`)
}

async function verifyInventory(directory, assets) {
  requireEqual(
    (await readdir(directory)).sort(),
    assets.map((asset) => asset.name).sort(),
    "Local full asset inventory",
  )
  for (const asset of assets) {
    const path = join(directory, asset.name)
    const metadata = await stat(path)
    requireCondition(
      metadata.isFile() &&
        metadata.size === asset.size &&
        (await hashFile(path)) === asset.digest.slice(7),
      `Frozen local asset mismatch: ${asset.name}`,
    )
  }
}

async function verifyManifest(directory, identity, assets) {
  const manifest = JSON.parse(await readFile(join(directory, manifestName), "utf8"))
  requireCondition(
    manifest.schemaVersion === 1 &&
      manifest.repository === repository &&
      manifest.tag === identity.tag &&
      manifest.version === identity.version &&
      typeof manifest.generatedAt === "string" &&
      Number.isFinite(Date.parse(manifest.generatedAt)) &&
      Array.isArray(manifest.assets),
    "Release asset manifest schema/identity mismatch",
  )
  const expected = assets
    .filter((asset) => asset.name !== manifestName)
    .map((asset) => ({
      name: asset.name,
      ...classifyReleaseAsset(asset.name),
      bytes: asset.size,
      sha256: asset.digest.slice(7),
      downloadUrl: asset.browser_download_url,
    }))
  const actual = [...manifest.assets].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  requireEqual(actual, expected, "Full manifest inventory/digests/URLs")
  return {
    schemaVersion: manifest.schemaVersion,
    verifiedEntries: actual.length,
    sha256: await hashFile(join(directory, manifestName)),
  }
}

function receiptEntry(identity, frozen, directory) {
  const assets = frozen.release.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    bytes: asset.size,
    sha256: asset.digest.slice(7),
  }))
  function selected(name) {
    const asset = assets.find((item) => item.name === name)
    requireCondition(asset, `Required native installer is missing: ${name}`)
    return { path: join(directory, name), sha256: asset.sha256 }
  }
  return {
    ...identity,
    tagObjectSha: frozen.tag.sha,
    assetsDir: directory,
    assets,
    windowsInstaller: selected(`OMP.Desktop_${identity.version}_x64-setup.exe`),
    linuxAppImage: selected(`OMP.Desktop_${identity.version}_amd64.AppImage`),
  }
}

async function main() {
  requireCondition(
    process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === "--recheck"),
    "Usage: node prepare-production-assets.mjs [--recheck]",
  )
  mode = process.argv[2] === "--recheck" ? "recheck" : "prepare"
  const target = {
    tag: "v0.9.11",
    version: "0.9.11",
    commit: process.env.PRODUCTION_TARGET_SHA ?? "",
    releaseId: inputId("PRODUCTION_TARGET_RELEASE_ID"),
    releaseRunId: inputId("PRODUCTION_TARGET_RUN_ID"),
  }
  requireCondition(
    /^[0-9a-f]{40}$/.test(target.commit) && target.commit !== baseIdentity.commit,
    "PRODUCTION_TARGET_SHA must be the exact target commit SHA",
  )
  requireCondition(
    target.releaseId !== baseIdentity.releaseId,
    "Target release cannot be the baseline",
  )
  const workInput = process.env.PRODUCTION_WORK_DIR
  const evidenceInput = process.env.PRODUCTION_EVIDENCE_DIR
  requireCondition(
    workInput && isAbsolute(workInput) && evidenceInput && isAbsolute(evidenceInput),
    "Absolute PRODUCTION_WORK_DIR and PRODUCTION_EVIDENCE_DIR are required",
  )
  const workDir = resolve(workInput)
  const requestedEvidence = resolve(evidenceInput)
  requireCondition(
    !inside(workDir, harnessRoot) &&
      !inside(harnessRoot, workDir) &&
      !inside(requestedEvidence, harnessRoot) &&
      !inside(harnessRoot, requestedEvidence) &&
      !inside(workDir, targetRoot) &&
      !inside(targetRoot, workDir) &&
      !inside(requestedEvidence, targetRoot) &&
      !inside(targetRoot, requestedEvidence) &&
      !inside(requestedEvidence, workDir) &&
      !inside(workDir, requestedEvidence),
    "Work/evidence/source directories must be separate and non-overlapping",
  )
  if (mode === "prepare") {
    await mkdir(dirname(requestedEvidence), { recursive: true })
    await mkdir(requestedEvidence)
  } else {
    requireCondition(
      (await stat(requestedEvidence)).isDirectory(),
      "Recheck requires existing evidence",
    )
  }
  evidenceDir = requestedEvidence
  stage = "checkout"
  await checkCheckout(target.commit)
  if (mode === "recheck") {
    stage = "final-identity"
    const frozen = JSON.parse(
      await readFile(join(evidenceDir, "frozen-production-metadata.json"), "utf8"),
    )
    const final = await snapshot(target)
    await jsonEvidence("final-production-metadata.json", final)
    requireEqual(final, frozen, "Final immutable production metadata")
    const expected = {
      repository,
      base: receiptEntry(baseIdentity, frozen.base, join(workDir, "base")),
      target: receiptEntry(target, frozen.target, join(workDir, "target")),
    }
    requireEqual(
      JSON.parse(await readFile(join(evidenceDir, "verified-production-assets.json"), "utf8")),
      expected,
      "Verified receipt binding",
    )
    for (const role of ["base", "target"])
      await verifyInventory(expected[role].assetsDir, frozen[role].release.assets)
    await jsonEvidence("production-assets-final-gate.json", {
      result: "PASS",
      repository,
      target,
      checkedAt: new Date().toISOString(),
    })
    console.log(
      "Production immutable metadata/all-assets final gate PASS (not a built-in updater result)",
    )
    return
  }
  stage = "production-trust"
  const updaterPublicKey = await productionKey()
  stage = "freeze-identity"
  const frozen = await snapshot(target)
  await jsonEvidence("frozen-production-metadata.json", frozen)
  stage = "download-all-assets"
  await mkdir(dirname(workDir), { recursive: true })
  await mkdir(workDir)
  const summaries = {}
  for (const [role, identity] of [
    ["base", baseIdentity],
    ["target", target],
  ]) {
    const directory = join(workDir, role)
    await mkdir(directory)
    const metadata = frozen[role].release
    stage = `download-${role}`
    for (const asset of metadata.assets) await download(asset, directory)
    stage = `verify-${role}`
    await verifyInventory(directory, metadata.assets)
    const signatures = await verifyReleaseAssets({
      directory,
      tag: identity.tag,
      version: identity.version,
      repository,
      releaseMetadata: metadata,
      updaterPublicKey,
      releaseState: role === "base" ? "stable" : "candidate-prerelease",
    })
    const manifest = await verifyManifest(directory, identity, metadata.assets)
    summaries[role] = { signatures, manifest, assets: metadata.assets.length }
    await jsonEvidence(`${role}-verifier-summary.json`, summaries[role])
  }
  stage = "post-download-identity"
  const after = await snapshot(target)
  await jsonEvidence("post-download-production-metadata.json", after)
  requireEqual(after, frozen, "Post-download immutable production metadata")
  await checkCheckout(target.commit)
  stage = "receipt"
  const receipt = {
    repository,
    base: receiptEntry(baseIdentity, frozen.base, join(workDir, "base")),
    target: receiptEntry(target, frozen.target, join(workDir, "target")),
  }
  await jsonEvidence("verified-production-assets.json", receipt)
  await jsonEvidence("production-assets-gate.json", {
    result: "PASS",
    repository,
    target,
    summaries,
    checkedAt: new Date().toISOString(),
  })
  console.log("Production immutable all-assets/Minisign/checksum/manifest acquisition gate PASS")
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : "Production asset gate failed"
  // No stacks, request objects, environment dumps or authorization headers.
  const safeMessage = process.env.GH_TOKEN
    ? message.replaceAll(process.env.GH_TOKEN, "[REDACTED]")
    : message
  if (evidenceDir) {
    await jsonEvidence(`production-assets-${mode}-failure.json`, {
      result: "FAIL",
      stage,
      message: safeMessage,
      failedAt: new Date().toISOString(),
    }).catch(() => {})
  }
  console.error(`Production asset gate FAIL at ${stage}: ${safeMessage}`)
  process.exitCode = 1
}

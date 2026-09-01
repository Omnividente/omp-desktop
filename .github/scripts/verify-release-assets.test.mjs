import { execFile } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classifyReleaseAsset,
  releaseAssetContentType,
  recoverStagedReleaseAssets,
  releasePublicationDisposition,
  replaceReleaseAssetSafely,
  requireCandidatePrerelease,
  requireDraftPrerelease,
  requireDraftRelease,
  requireStableRelease,
  selectDraftRelease,
  stagedReleaseAssetName,
  waitForDraftRelease,
  verifyReleaseAssets,
  writeReleaseChecksums,
} from "./verify-release-assets.mjs"

const directories = []

function hash(content) {
  return createHash("sha256").update(content).digest("hex")
}

function checksumFor(names, assets) {
  const byName = new Map(Object.values(assets).map((asset) => [asset.name, asset]))
  return `${names.map((name) => `${hash(byName.get(name).bytes)}  ${name}`).join("\n")}\n`
}

function createSigningKey(keyIdHex = "bfd61d9fd4bda0f6") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  const keyId = Buffer.from(keyIdHex, "hex")
  const publicPayload = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey])
  const displayedKeyId = Buffer.from(keyId).reverse().toString("hex").toUpperCase()
  const publicKeyText = [
    `untrusted comment: minisign public key: ${displayedKeyId}`,
    publicPayload.toString("base64"),
    "",
  ].join("\n")
  return {
    keyId,
    privateKey,
    updaterPublicKey: Buffer.from(publicKeyText, "utf8").toString("base64"),
  }
}

function createUpdaterSignature(name, bytes, signingKey) {
  const artifactDigest = createHash("blake2b512").update(bytes).digest()
  const signature = sign(null, artifactDigest, signingKey.privateKey)
  const payload = Buffer.concat([Buffer.from("ED"), signingKey.keyId, signature])
  const trustedComment = `timestamp:1700000000\tfile:${name}`
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    signingKey.privateKey,
  )
  const signatureText = [
    "untrusted comment: signature from tauri secret key",
    payload.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n")
  return Buffer.from(signatureText, "utf8").toString("base64")
}

async function releaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "omp-release-assets-"))
  directories.push(directory)
  const version = "1.2.3"
  const tag = `v${version}`
  const repository = "example/repo"
  const apiBase = `https://api.github.com/repos/${repository}/releases/assets`
  const signingKey = createSigningKey()
  const definitions = [
    {
      key: "appImage",
      name: `OMP.Desktop_${version}_amd64.AppImage`,
      platform: "linux-x86_64-appimage",
      id: 101,
      os: "linux",
    },
    {
      key: "deb",
      name: `OMP.Desktop_${version}_amd64.deb`,
      platform: "linux-x86_64-deb",
      id: 102,
      os: "linux",
    },
    {
      key: "rpm",
      name: `OMP.Desktop-${version}-1.x86_64.rpm`,
      platform: "linux-x86_64-rpm",
      id: 103,
      os: "linux",
    },
    {
      key: "nsis",
      name: `OMP.Desktop_${version}_x64-setup.exe`,
      platform: "windows-x86_64-nsis",
      id: 104,
      os: "windows",
    },
    {
      key: "msi",
      name: `OMP.Desktop_${version}_x64_en-US.msi`,
      platform: "windows-x86_64-msi",
      id: 105,
      os: "windows",
    },
  ]
  const assets = Object.fromEntries(
    definitions.map((definition) => {
      const bytes = Buffer.from(`${definition.key}-installer`)
      const signature = createUpdaterSignature(definition.name, bytes, signingKey)
      return [definition.key, { ...definition, bytes, signature }]
    }),
  )
  const updater = {
    version,
    platforms: Object.fromEntries(
      definitions.map(({ key, platform, id }) => [
        platform,
        { signature: assets[key].signature, url: `${apiBase}/${id}` },
      ]),
    ),
  }

  await Promise.all([
    ...Object.values(assets).flatMap((asset) => [
      writeFile(join(directory, asset.name), asset.bytes),
      writeFile(join(directory, `${asset.name}.sig`), asset.signature),
    ]),
    writeFile(join(directory, "latest.json"), JSON.stringify(updater)),
  ])
  await writeReleaseChecksums({ directory })

  const releaseMetadata = {
    id: 999,
    draft: true,
    prerelease: true,
    tag_name: tag,
    assets: [
      ...definitions.map(({ key, name, id }) => ({
        name,
        content_type: releaseAssetContentType(name),
        url: `${apiBase}/${id}`,
        browser_download_url: `https://github.com/${repository}/releases/download/untagged-fixture/${assets[key].name}`,
      })),
      {
        name: "latest.json",
        content_type: "application/json",
        url: `${apiBase}/106`,
        browser_download_url: `https://github.com/${repository}/releases/download/untagged-fixture/latest.json`,
      },
    ],
  }
  const linuxInstallers = definitions
    .filter(({ os }) => os === "linux")
    .map(({ name }) => name)
    .sort()
  const windowsInstallers = definitions
    .filter(({ os }) => os === "windows")
    .map(({ name }) => name)
    .sort()
  return {
    assets,
    directory,
    linuxInstallers,
    releaseMetadata,
    repository,
    signingKey,
    tag,
    updater,
    version,
    windowsInstallers,
    updaterPublicKey: signingKey.updaterPublicKey,
  }
}

async function writeUpdater(fixture) {
  await writeFile(join(fixture.directory, "latest.json"), JSON.stringify(fixture.updater))
}

async function writeSignedAsset(fixture, asset, bytes, signingKey = fixture.signingKey) {
  asset.bytes = Buffer.from(bytes)
  asset.signature = createUpdaterSignature(asset.name, asset.bytes, signingKey)
  fixture.updater.platforms[asset.platform].signature = asset.signature
  await Promise.all([
    writeFile(join(fixture.directory, asset.name), asset.bytes),
    writeFile(join(fixture.directory, `${asset.name}.sig`), asset.signature),
    writeUpdater(fixture),
  ])
}

const verifierPath = fileURLToPath(new URL("./verify-release-assets.mjs", import.meta.url))

async function runVerifierCli(fixture, releaseMetadata, mode) {
  const root = await mkdtemp(join(tmpdir(), "omp-release-cli-"))
  directories.push(root)
  await mkdir(join(root, "src-tauri"), { recursive: true })
  const metadataPath = join(root, "release-metadata.json")
  await Promise.all([
    writeFile(metadataPath, JSON.stringify(releaseMetadata)),
    writeFile(
      join(root, "src-tauri", "tauri.conf.json"),
      JSON.stringify({ plugins: { updater: { pubkey: fixture.updaterPublicKey } } }),
    ),
  ])

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [verifierPath, mode, fixture.directory],
      {
        cwd: root,
        env: {
          ...process.env,
          RELEASE_METADATA: metadataPath,
          RELEASE_TAG: fixture.tag,
          RELEASE_VERSION: fixture.version,
          RELEASE_REPOSITORY: fixture.repository,
        },
        maxBuffer: 1_000_000,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    )
  })
}

function fakeReleaseAssetClient(initialAssets, failures = {}) {
  let assets = structuredClone(initialAssets)
  let nextId = Math.max(0, ...assets.map((asset) => asset.id)) + 1
  const calls = []
  const release = () => ({ assets: structuredClone(assets) })
  const consumeFailure = (name) => {
    if (!failures[name]) return false
    failures[name] -= 1
    return true
  }
  const client = {
    loadRelease: async () => release(),
    uploadAsset: async ({ path, name, contentType, label }) => {
      assert.equal(
        assets.some((asset) => asset.name === name),
        false,
      )
      const bytes = await readFile(path)
      const asset = {
        id: nextId++,
        name,
        label: label || null,
        content_type: contentType,
        digest: `sha256:${hash(bytes)}`,
        state: "uploaded",
      }
      assets.push(asset)
      calls.push(["upload", name])
      if (consumeFailure("uploadAfterCreate")) throw new Error("upload response lost")
      return structuredClone(asset)
    },
    updateAsset: async (assetId, { name, label }) => {
      calls.push(["update", assetId, name])
      if (consumeFailure("updateBeforeChange")) throw new Error("rename failed")
      const asset = assets.find((candidate) => candidate.id === assetId)
      assert.ok(asset)
      assert.equal(
        assets.some((candidate) => candidate.id !== assetId && candidate.name === name),
        false,
      )
      asset.name = name
      asset.label = label || null
      return structuredClone(asset)
    },
    deleteAsset: async (assetId) => {
      calls.push(["delete", assetId])
      const index = assets.findIndex((asset) => asset.id === assetId)
      assert.notEqual(index, -1)
      assets.splice(index, 1)
      if (consumeFailure("deleteAfterChange")) throw new Error("delete response lost")
    },
  }
  return { client, calls, snapshot: () => structuredClone(assets) }
}

async function replacementFixture(label) {
  const directory = await mkdtemp(join(tmpdir(), `omp-release-replacement-${label}-`))
  directories.push(directory)
  const path = join(directory, "artifact.bin")
  const bytes = Buffer.from("replacement bytes")
  await writeFile(path, bytes)
  return { path, bytes, digest: `sha256:${hash(bytes)}` }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("release asset verification", () => {
  it("accepts every signed package with GitHub API targets and exact checksums", async () => {
    const fixture = await releaseFixture()
    const summary = await verifyReleaseAssets(fixture)

    assert.deepEqual(summary.linuxInstallers, fixture.linuxInstallers)
    assert.deepEqual(summary.windowsInstallers, fixture.windowsInstallers)
    assert.equal(summary.signedInstallers, 5)
    assert.equal(summary.updaterTargets, 5)
    assert.equal(summary.verifiedSignatures, 5)
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-linux.txt"), "utf8"),
      checksumFor(fixture.linuxInstallers, fixture.assets),
    )
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-windows.txt"), "utf8"),
      checksumFor(fixture.windowsInstallers, fixture.assets),
    )
  })
  it("rejects a latest.json asset uploaded with the wrong media type", async () => {
    const fixture = await releaseFixture()
    const updaterAsset = fixture.releaseMetadata.assets.find(
      (asset) => asset.name === "latest.json",
    )
    updaterAsset.content_type = "application/zip"

    await assert.rejects(
      () => verifyReleaseAssets(fixture),
      /latest\.json must use Content-Type application\/json, got application\/zip/,
    )
  })

  it("rejects installer media types mislabeled as zip archives", async () => {
    const fixture = await releaseFixture()
    fixture.releaseMetadata.assets[0].content_type = "application/zip"

    await assert.rejects(
      () => verifyReleaseAssets(fixture),
      /must use Content-Type application\/octet-stream, got application\/zip/,
    )
  })
  it("accepts a public candidate prerelease state", async () => {
    const fixture = await releaseFixture()
    const releaseMetadata = { ...fixture.releaseMetadata, draft: false, prerelease: true }

    const summary = await verifyReleaseAssets({
      ...fixture,
      releaseMetadata,
      releaseState: "candidate-prerelease",
    })

    assert.equal(summary.verifiedSignatures, 5)
  })
  it("fails closed in CLI mode for tampered assets and confused states", async () => {
    const fixture = await releaseFixture()
    const candidate = { ...fixture.releaseMetadata, draft: false, prerelease: true }

    const valid = await runVerifierCli(fixture, candidate, "--verify-candidate-prerelease")
    assert.ifError(valid.error)

    await writeFile(join(fixture.directory, fixture.assets.appImage.name), "tampered")
    const tampered = await runVerifierCli(fixture, candidate, "--verify-candidate-prerelease")
    assert.ok(tampered.error)
    assert.match(tampered.stderr, /cryptographically invalid/)

    const draft = { ...candidate, draft: true }
    const confused = await runVerifierCli(fixture, draft, "--verify-candidate-prerelease")
    assert.ok(confused.error)
    assert.match(confused.stderr, /not in candidate-prerelease state/)

    const stableConfused = await runVerifierCli(fixture, candidate, "--verify-stable")
    assert.ok(stableConfused.error)
    assert.match(stableConfused.stderr, /not in stable state/)
  })

  it("rejects a missing installer signature before release publication", async () => {
    const fixture = await releaseFixture()
    await rm(join(fixture.directory, `${fixture.assets.nsis.name}.sig`))

    await assert.rejects(() => verifyReleaseAssets(fixture), /Updater signature is missing/)
  })

  it("rejects installer bytes that do not match their cryptographic signature", async () => {
    const fixture = await releaseFixture()
    await writeFile(join(fixture.directory, fixture.assets.appImage.name), "tampered")

    await assert.rejects(
      () => verifyReleaseAssets(fixture),
      /Updater signature is cryptographically invalid/,
    )
  })

  it("rejects signatures made by a key other than the configured updater key", async () => {
    const fixture = await releaseFixture()
    const wrongSigningKey = createSigningKey("0102030405060708")
    await writeSignedAsset(fixture, fixture.assets.nsis, fixture.assets.nsis.bytes, wrongSigningKey)

    await assert.rejects(
      () => verifyReleaseAssets(fixture),
      /Updater signature key does not match configured public key/,
    )
  })

  it("rejects a checksum that does not match the uploaded installer", async () => {
    const fixture = await releaseFixture()
    await writeSignedAsset(fixture, fixture.assets.appImage, "tampered")

    await assert.rejects(() => verifyReleaseAssets(fixture), /SHA-256 mismatch/)
  })

  it("rejects a checksum with an unexpected asset entry", async () => {
    const fixture = await releaseFixture()
    const checksumPath = join(fixture.directory, "SHA256SUMS-linux.txt")
    const checksum = await readFile(checksumPath, "utf8")
    await writeFile(checksumPath, `${checksum}${hash("unexpected")}  unrelated.deb\n`)

    await assert.rejects(() => verifyReleaseAssets(fixture), /contains an unexpected entry/)
  })

  it("rejects an updater URL that is not in release metadata", async () => {
    const fixture = await releaseFixture()
    fixture.updater.platforms[fixture.assets.appImage.platform].url =
      `https://api.github.com/repos/${fixture.repository}/releases/assets/999`
    await writeUpdater(fixture)

    await assert.rejects(() => verifyReleaseAssets(fixture), /Updater URL is not an asset/)
  })

  it("rejects a latest.json signature that differs from its uploaded asset", async () => {
    const fixture = await releaseFixture()
    fixture.updater.platforms[fixture.assets.msi.platform].signature = "wrong-signature"
    await writeUpdater(fixture)

    await assert.rejects(() => verifyReleaseAssets(fixture), /latest.json signature does not match/)
  })

  it("rejects a release missing any required package format", async () => {
    const fixture = await releaseFixture()
    await Promise.all([
      rm(join(fixture.directory, fixture.assets.rpm.name)),
      rm(join(fixture.directory, `${fixture.assets.rpm.name}.sig`)),
    ])

    await assert.rejects(() => verifyReleaseAssets(fixture), /No RPM installer is present/)
  })

  it("rejects an installer omitted from latest.json", async () => {
    const fixture = await releaseFixture()
    delete fixture.updater.platforms[fixture.assets.deb.platform]
    await writeUpdater(fixture)

    await assert.rejects(() => verifyReleaseAssets(fixture), /latest.json has no updater target/)
  })

  it("rejects a stale installer from another version", async () => {
    const fixture = await releaseFixture()
    const stale = "OMP.Desktop_1.2.2_amd64.deb"
    await Promise.all([
      writeFile(join(fixture.directory, stale), "stale-installer"),
      writeFile(join(fixture.directory, `${stale}.sig`), "stale-signature"),
    ])
    await writeReleaseChecksums({ directory: fixture.directory })

    await assert.rejects(() => verifyReleaseAssets(fixture), /does not match release version/)
  })

  it("rejects a latest.json version that differs from the release version", async () => {
    const fixture = await releaseFixture()
    fixture.updater.version = "1.2.2"
    await writeUpdater(fixture)

    await assert.rejects(
      () => verifyReleaseAssets(fixture),
      /latest.json version 1.2.2 does not match 1.2.3/,
    )
  })

  it("rejects mutation of an already published release", async () => {
    const fixture = await releaseFixture()
    fixture.releaseMetadata.draft = false

    assert.throws(
      () => requireDraftRelease({ releaseMetadata: fixture.releaseMetadata, tag: fixture.tag }),
      /is already published/,
    )
  })

  it("enforces the draft, candidate, and stable state matrix", async () => {
    const fixture = await releaseFixture()
    const draft = { ...fixture.releaseMetadata, draft: true, prerelease: true }
    const candidate = { ...draft, draft: false, prerelease: true }
    const stable = { ...candidate, prerelease: false }

    assert.doesNotThrow(() => requireDraftRelease({ releaseMetadata: draft, tag: fixture.tag }))
    assert.doesNotThrow(() => requireDraftPrerelease({ releaseMetadata: draft, tag: fixture.tag }))
    assert.throws(
      () => requireCandidatePrerelease({ releaseMetadata: draft, tag: fixture.tag }),
      /not in candidate-prerelease state/,
    )
    assert.throws(
      () => requireStableRelease({ releaseMetadata: draft, tag: fixture.tag }),
      /not in stable state/,
    )

    assert.doesNotThrow(() =>
      requireCandidatePrerelease({ releaseMetadata: candidate, tag: fixture.tag }),
    )
    assert.throws(
      () => requireDraftPrerelease({ releaseMetadata: candidate, tag: fixture.tag }),
      /not in draft-prerelease state/,
    )
    assert.throws(
      () => requireStableRelease({ releaseMetadata: candidate, tag: fixture.tag }),
      /not in stable state/,
    )

    assert.doesNotThrow(() => requireStableRelease({ releaseMetadata: stable, tag: fixture.tag }))
    assert.throws(
      () => requireDraftRelease({ releaseMetadata: stable, tag: fixture.tag }),
      /is already published/,
    )
  })

  it("distinguishes a retryable draft from an already published candidate", async () => {
    const fixture = await releaseFixture()
    assert.equal(
      releasePublicationDisposition({
        releaseMetadata: fixture.releaseMetadata,
        tag: fixture.tag,
        expectedId: fixture.releaseMetadata.id,
      }),
      "draft",
    )
    assert.equal(
      releasePublicationDisposition({
        releaseMetadata: { ...fixture.releaseMetadata, draft: false, prerelease: true },
        tag: fixture.tag,
        expectedId: fixture.releaseMetadata.id,
      }),
      "candidate",
    )
    assert.throws(
      () =>
        releasePublicationDisposition({
          releaseMetadata: { ...fixture.releaseMetadata, draft: false, prerelease: false },
          tag: fixture.tag,
          expectedId: fixture.releaseMetadata.id,
        }),
      /not in candidate-prerelease state/,
    )
    assert.throws(
      () =>
        releasePublicationDisposition({
          releaseMetadata: fixture.releaseMetadata,
          tag: fixture.tag,
          expectedId: fixture.releaseMetadata.id + 1,
        }),
      /Expected release/,
    )
  })

  it("preserves the original asset when staging upload acknowledgement fails", async () => {
    const replacement = await replacementFixture("upload-failure")
    const original = {
      id: 1,
      name: "artifact.bin",
      label: null,
      content_type: "application/zip",
      digest: `sha256:${hash("original bytes")}`,
      state: "uploaded",
    }
    const fake = fakeReleaseAssetClient([original], { uploadAfterCreate: 1 })

    await assert.rejects(
      () =>
        replaceReleaseAssetSafely({
          client: fake.client,
          path: replacement.path,
          name: original.name,
          contentType: "application/octet-stream",
        }),
      /upload response lost/,
    )
    assert.deepEqual(fake.snapshot(), [original])
  })

  it("recovers a durable staged asset after delete succeeds and rename fails", async () => {
    const replacement = await replacementFixture("rename-failure")
    const original = {
      id: 1,
      name: "artifact.bin",
      label: null,
      content_type: "application/zip",
      digest: `sha256:${hash("original bytes")}`,
      state: "uploaded",
    }
    const fake = fakeReleaseAssetClient([original], { updateBeforeChange: 1 })

    await assert.rejects(
      () =>
        replaceReleaseAssetSafely({
          client: fake.client,
          path: replacement.path,
          name: original.name,
          contentType: "application/octet-stream",
        }),
      /rename failed/,
    )
    assert.equal(fake.snapshot()[0].name, stagedReleaseAssetName(original.name))

    assert.deepEqual(await recoverStagedReleaseAssets({ client: fake.client }), {
      recovered: [original.name],
      cleaned: [],
    })
    assert.deepEqual(fake.snapshot(), [
      {
        id: 2,
        name: original.name,
        label: null,
        content_type: "application/octet-stream",
        digest: replacement.digest,
        state: "uploaded",
      },
    ])
  })

  it("recovers an ambiguous successful delete without discarding staged bytes", async () => {
    const replacement = await replacementFixture("delete-response-loss")
    const original = {
      id: 1,
      name: "artifact.bin",
      label: null,
      content_type: "application/zip",
      digest: `sha256:${hash("original bytes")}`,
      state: "uploaded",
    }
    const fake = fakeReleaseAssetClient([original], { deleteAfterChange: 1 })

    await assert.rejects(
      () =>
        replaceReleaseAssetSafely({
          client: fake.client,
          path: replacement.path,
          name: original.name,
          contentType: "application/octet-stream",
        }),
      /delete response lost/,
    )
    assert.equal(fake.snapshot()[0].name, stagedReleaseAssetName(original.name))
    await recoverStagedReleaseAssets({ client: fake.client })
    assert.equal(fake.snapshot()[0].name, original.name)
    assert.equal(fake.snapshot()[0].digest, replacement.digest)
  })

  it("selects one draft release from paginated API metadata", async () => {
    const fixture = await releaseFixture()
    const selected = selectDraftRelease({
      releasePages: [[fixture.releaseMetadata]],
      tag: fixture.tag,
    })

    assert.equal(selected.id, fixture.releaseMetadata.id)
  })

  it("allows a missing release only before dedicated draft creation", async () => {
    const fixture = await releaseFixture()

    assert.equal(
      selectDraftRelease({ releasePages: [[]], tag: fixture.tag, allowMissing: true }),
      null,
    )
    assert.throws(
      () => selectDraftRelease({ releasePages: [[]], tag: fixture.tag }),
      /Expected exactly one release/,
    )
  })

  it("rejects duplicate draft releases for one tag", async () => {
    const fixture = await releaseFixture()
    const duplicate = { ...fixture.releaseMetadata, id: fixture.releaseMetadata.id + 1 }

    assert.throws(
      () =>
        selectDraftRelease({
          releasePages: [[fixture.releaseMetadata, duplicate]],
          tag: fixture.tag,
        }),
      /Expected at most one release/,
    )
  })

  it("retries a newly created draft with bounded backoff until it is visible", async () => {
    const fixture = await releaseFixture()
    const responses = [[[]], [[]], [[fixture.releaseMetadata]]]
    const waits = []
    const retries = []
    let loadCount = 0

    const release = await waitForDraftRelease({
      loadReleasePages: async () => responses[loadCount++],
      tag: fixture.tag,
      expectedId: fixture.releaseMetadata.id,
      delaysMs: [0, 10, 20],
      wait: async (delayMs) => waits.push(delayMs),
      onRetry: (retry) => retries.push(retry),
    })

    assert.equal(release.id, fixture.releaseMetadata.id)
    assert.equal(loadCount, 3)
    assert.deepEqual(waits, [10, 20])
    assert.deepEqual(retries, [
      { attempt: 1, totalAttempts: 3, nextDelayMs: 10 },
      { attempt: 2, totalAttempts: 3, nextDelayMs: 20 },
    ])
  })

  it("fails closed after the bounded draft visibility schedule is exhausted", async () => {
    const fixture = await releaseFixture()
    let loadCount = 0

    await assert.rejects(
      () =>
        waitForDraftRelease({
          loadReleasePages: async () => {
            loadCount += 1
            return [[]]
          },
          tag: fixture.tag,
          expectedId: fixture.releaseMetadata.id,
          delaysMs: [0, 10, 20],
          wait: async () => {},
        }),
      /was not visible after 3 attempts/,
    )
    assert.equal(loadCount, 3)
  })

  it("rejects a visible draft whose id differs from the created release", async () => {
    const fixture = await releaseFixture()
    const otherDraft = { ...fixture.releaseMetadata, id: fixture.releaseMetadata.id + 1 }

    await assert.rejects(
      () =>
        waitForDraftRelease({
          loadReleasePages: async () => [[otherDraft]],
          tag: fixture.tag,
          expectedId: fixture.releaseMetadata.id,
          delaysMs: [0],
        }),
      /but resolved/,
    )
  })

  it("classifies release assets by anchored package suffixes", () => {
    assert.deepEqual(classifyReleaseAsset("OMP.twin-build_1.2.3_amd64.deb.sig"), {
      kind: "signature",
      platform: "linux",
    })
    assert.deepEqual(classifyReleaseAsset("OMP.Desktop_1.2.3_x64_en-US.msi.sig"), {
      kind: "signature",
      platform: "windows",
    })
    assert.deepEqual(classifyReleaseAsset("OMP.Desktop_1.2.3_amd64.AppImage.tar.gz"), {
      kind: "updater-bundle",
      platform: "linux",
    })
    assert.deepEqual(classifyReleaseAsset("latest.json"), {
      kind: "updater-manifest",
      platform: "metadata",
    })
  })

  it("assigns deterministic media types to every release asset class", () => {
    assert.equal(releaseAssetContentType("latest.json"), "application/json")
    assert.equal(releaseAssetContentType("release-assets-manifest.json"), "application/json")
    assert.equal(releaseAssetContentType("SHA256SUMS-linux.txt"), "text/plain")
    assert.equal(releaseAssetContentType("OMP.Desktop.AppImage.sig"), "text/plain")
    assert.equal(releaseAssetContentType("OMP.Desktop.AppImage.tar.gz"), "application/gzip")
    assert.equal(releaseAssetContentType("OMP.Desktop.nsis.zip"), "application/zip")
    assert.equal(releaseAssetContentType("OMP.Desktop.AppImage"), "application/octet-stream")
  })
})

import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classifyReleaseAsset,
  requireDraftRelease,
  selectDraftRelease,
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

async function releaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "omp-release-assets-"))
  directories.push(directory)
  const version = "1.2.3"
  const tag = `v${version}`
  const repository = "example/repo"
  const apiBase = `https://api.github.com/repos/${repository}/releases/assets`
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
      const signature = `${definition.key}-signature`
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
    tag_name: tag,
    assets: definitions.map(({ key, name, id }) => ({
      name,
      url: `${apiBase}/${id}`,
      browser_download_url: `https://github.com/${repository}/releases/download/untagged-fixture/${assets[key].name}`,
    })),
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
    tag,
    updater,
    version,
    windowsInstallers,
  }
}

async function writeUpdater(fixture) {
  await writeFile(join(fixture.directory, "latest.json"), JSON.stringify(fixture.updater))
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
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-linux.txt"), "utf8"),
      checksumFor(fixture.linuxInstallers, fixture.assets),
    )
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-windows.txt"), "utf8"),
      checksumFor(fixture.windowsInstallers, fixture.assets),
    )
  })

  it("rejects a missing installer signature before release publication", async () => {
    const fixture = await releaseFixture()
    await rm(join(fixture.directory, `${fixture.assets.nsis.name}.sig`))

    await assert.rejects(() => verifyReleaseAssets(fixture), /Updater signature is missing/)
  })

  it("rejects a checksum that does not match the uploaded installer", async () => {
    const fixture = await releaseFixture()
    await writeFile(join(fixture.directory, fixture.assets.appImage.name), "tampered")

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

  it("rejects mutation of an already published release", async () => {
    const fixture = await releaseFixture()
    fixture.releaseMetadata.draft = false

    assert.throws(
      () => requireDraftRelease({ releaseMetadata: fixture.releaseMetadata, tag: fixture.tag }),
      /is already published/,
    )
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
})

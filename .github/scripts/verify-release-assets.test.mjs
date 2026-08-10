import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { verifyReleaseAssets, writeReleaseChecksums } from "./verify-release-assets.mjs"

const directories = []

function hash(content) {
  return createHash("sha256").update(content).digest("hex")
}

async function releaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "omp-release-assets-"))
  directories.push(directory)
  const version = "1.2.3"
  const tag = `v${version}`
  const repository = "example/repo"
  const linux = `OMP.Desktop_${version}_amd64.AppImage`
  const windows = `OMP.Desktop_${version}_x64-setup.exe`
  const linuxBytes = Buffer.from("linux-installer")
  const windowsBytes = Buffer.from("windows-installer")
  const linuxSignature = "linux-signature"
  const windowsSignature = "windows-signature"
  const apiBase = `https://api.github.com/repos/${repository}/releases/assets`
  const updater = {
    version,
    platforms: {
      "linux-x86_64": {
        signature: linuxSignature,
        url: `${apiBase}/101`,
      },
      "windows-x86_64": {
        signature: windowsSignature,
        url: `${apiBase}/102`,
      },
    },
  }

  await Promise.all([
    writeFile(join(directory, linux), linuxBytes),
    writeFile(join(directory, `${linux}.sig`), linuxSignature),
    writeFile(join(directory, windows), windowsBytes),
    writeFile(join(directory, `${windows}.sig`), windowsSignature),
    writeFile(join(directory, "latest.json"), JSON.stringify(updater)),
  ])
  await writeReleaseChecksums({ directory })

  const releaseMetadata = {
    tag_name: tag,
    assets: [
      {
        name: linux,
        url: `${apiBase}/101`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${linux}`,
      },
      {
        name: windows,
        url: `${apiBase}/102`,
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${windows}`,
      },
    ],
  }
  return {
    directory,
    linux,
    linuxBytes,
    releaseMetadata,
    repository,
    tag,
    updater,
    version,
    windows,
    windowsBytes,
  }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("release asset verification", () => {
  it("accepts signed GitHub API updater targets with exact downloaded checksums", async () => {
    const fixture = await releaseFixture()
    const summary = await verifyReleaseAssets(fixture)

    assert.deepEqual(summary.linuxInstallers, [fixture.linux])
    assert.deepEqual(summary.windowsInstallers, [fixture.windows])
    assert.equal(summary.signedInstallers, 2)
    assert.equal(summary.updaterTargets, 2)
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-linux.txt"), "utf8"),
      `${hash(fixture.linuxBytes)}  ${fixture.linux}\n`,
    )
    assert.equal(
      await readFile(join(fixture.directory, "SHA256SUMS-windows.txt"), "utf8"),
      `${hash(fixture.windowsBytes)}  ${fixture.windows}\n`,
    )
  })

  it("rejects a missing installer signature before release publication", async () => {
    const fixture = await releaseFixture()
    await rm(join(fixture.directory, `${fixture.windows}.sig`))

    await assert.rejects(() => verifyReleaseAssets(fixture), /Updater signature is missing/)
  })

  it("rejects a checksum that does not match the uploaded installer", async () => {
    const fixture = await releaseFixture()
    await writeFile(join(fixture.directory, fixture.linux), "tampered")

    await assert.rejects(() => verifyReleaseAssets(fixture), /SHA-256 mismatch/)
  })

  it("rejects an updater URL that is not in release metadata", async () => {
    const fixture = await releaseFixture()
    fixture.updater.platforms["linux-x86_64"].url =
      `https://api.github.com/repos/${fixture.repository}/releases/assets/999`
    await writeFile(join(fixture.directory, "latest.json"), JSON.stringify(fixture.updater))

    await assert.rejects(() => verifyReleaseAssets(fixture), /Updater URL is not an asset/)
  })

  it("rejects a latest.json signature that differs from its uploaded asset", async () => {
    const fixture = await releaseFixture()
    fixture.updater.platforms["windows-x86_64"].signature = "wrong-signature"
    await writeFile(join(fixture.directory, "latest.json"), JSON.stringify(fixture.updater))

    await assert.rejects(() => verifyReleaseAssets(fixture), /latest.json signature does not match/)
  })
})

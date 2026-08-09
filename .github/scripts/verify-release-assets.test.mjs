import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { verifyReleaseAssets } from "./verify-release-assets.mjs"

const directories = []

async function hash(content) {
  return createHash("sha256").update(content).digest("hex")
}

async function releaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "omp-release-assets-"))
  directories.push(directory)
  const version = "1.2.3"
  const tag = `v${version}`
  const linux = `OMP.Desktop_${version}_amd64.AppImage`
  const windows = `OMP.Desktop_${version}_x64-setup.exe`
  const linuxBytes = Buffer.from("linux-installer")
  const windowsBytes = Buffer.from("windows-installer")

  await Promise.all([
    writeFile(join(directory, linux), linuxBytes),
    writeFile(join(directory, `${linux}.sig`), "linux-signature"),
    writeFile(join(directory, windows), windowsBytes),
    writeFile(join(directory, `${windows}.sig`), "windows-signature"),
    writeFile(
      join(directory, "SHA256SUMS-linux.txt"),
      `${await hash(linuxBytes)}  appimage/${linux}\n`,
    ),
    writeFile(
      join(directory, "SHA256SUMS-windows.txt"),
      `${await hash(windowsBytes)}  nsis/${windows}\n`,
    ),
    writeFile(
      join(directory, "latest.json"),
      JSON.stringify({
        version,
        platforms: {
          "linux-x86_64": {
            signature: "linux-signature",
            url: `https://github.com/example/repo/releases/download/${tag}/${linux}`,
          },
          "windows-x86_64": {
            signature: "windows-signature",
            url: `https://github.com/example/repo/releases/download/${tag}/${windows}`,
          },
        },
      }),
    ),
  ])
  return { directory, linux, tag, version, windows }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("release asset verification", () => {
  it("accepts signed cross-platform installers with matching checksums and updater targets", async () => {
    const fixture = await releaseFixture()
    const summary = await verifyReleaseAssets(fixture)

    assert.deepEqual(summary.linuxInstallers, [fixture.linux])
    assert.deepEqual(summary.windowsInstallers, [fixture.windows])
    assert.equal(summary.signedInstallers, 2)
    assert.equal(summary.updaterTargets, 2)
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
})

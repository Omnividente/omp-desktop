import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildUpdaterManifest, validateMarkerEvents } from "./run-updater-e2e.mjs"

describe("updater E2E harness", () => {
  it("builds platform-specific signed updater manifests", () => {
    assert.deepEqual(
      buildUpdaterManifest({
        platform: "win32",
        signature: " signed-value \n",
        targetVersion: "0.6.1",
        assetUrl: "http://127.0.0.1:17823/target/app.exe",
      }),
      {
        version: "0.6.1",
        notes: "OMP Desktop updater E2E 0.6.1",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: {
          "windows-x86_64": {
            signature: "signed-value",
            url: "http://127.0.0.1:17823/target/app.exe",
          },
        },
      },
    )

    const linux = buildUpdaterManifest({
      platform: "linux",
      signature: "linux-signature",
      targetVersion: "0.6.1",
      assetUrl: "http://127.0.0.1:17823/target/app.AppImage",
    })
    assert.deepEqual(Object.keys(linux.platforms), ["linux-x86_64"])
  })

  it("accepts only a complete ordered install and restart sequence", () => {
    const events = [
      { event: "started", version: "0.6.0", detail: null },
      { event: "update-found", version: "0.6.0", detail: "0.6.1" },
      { event: "installed", version: "0.6.0", detail: "0.6.1" },
      { event: "started", version: "0.6.1", detail: null },
      { event: "complete", version: "0.6.1", detail: null },
    ]

    assert.doesNotThrow(() => validateMarkerEvents(events, "0.6.0", "0.6.1"))
    assert.throws(
      () => validateMarkerEvents(events.slice(0, -1), "0.6.0", "0.6.1"),
      /marker is incomplete/,
    )
  })

  it("surfaces application-side updater failures", () => {
    assert.throws(
      () =>
        validateMarkerEvents(
          [
            { event: "started", version: "0.6.0", detail: null },
            { event: "error", version: "0.6.0", detail: "signature rejected" },
          ],
          "0.6.0",
          "0.6.1",
        ),
      /signature rejected/,
    )
  })
})

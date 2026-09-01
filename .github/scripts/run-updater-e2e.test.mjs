import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildUpdaterManifest,
  compareStableVersions,
  parseWindowsExecutableVersion,
  validateMarkerEvents,
} from "./run-updater-e2e.mjs"

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

  it("requires the installed marker before a Linux restart", () => {
    const events = [
      { event: "started", version: "0.6.0", detail: null },
      { event: "update-found", version: "0.6.0", detail: "0.6.1" },
      { event: "installed", version: "0.6.0", detail: "0.6.1" },
      { event: "started", version: "0.6.1", detail: null },
      { event: "complete", version: "0.6.1", detail: null },
    ]

    assert.doesNotThrow(() => validateMarkerEvents(events, "0.6.0", "0.6.1", "linux"))
    assert.throws(
      () =>
        validateMarkerEvents(
          events.filter((event) => event.event !== "installed"),
          "0.6.0",
          "0.6.1",
          "linux",
        ),
      /expected installed 0\.6\.0/,
    )
  })

  it("accepts a completed Windows restart when NSIS replaces the base process", () => {
    const observedWindowsEvents = [
      { event: "started", version: "0.7.1", detail: null },
      { event: "update-found", version: "0.7.1", detail: "0.7.2" },
      { event: "started", version: "0.7.2", detail: null },
      { event: "complete", version: "0.7.2", detail: null },
    ]

    assert.doesNotThrow(() =>
      validateMarkerEvents(observedWindowsEvents, "0.7.1", "0.7.2", "win32"),
    )
    assert.throws(
      () => validateMarkerEvents(observedWindowsEvents.slice(0, -1), "0.7.1", "0.7.2", "win32"),
      /expected complete 0\.7\.2/,
    )
  })

  it("rejects extra or out-of-order lifecycle markers", () => {
    const events = [
      { event: "started", version: "0.7.1", detail: null },
      { event: "update-found", version: "0.7.1", detail: "0.7.2" },
      { event: "started", version: "0.7.2", detail: null },
      { event: "complete", version: "0.7.2", detail: null },
    ]
    assert.throws(
      () =>
        validateMarkerEvents(
          [events[0], { event: "started", version: "0.7.1", detail: null }, ...events.slice(1)],
          "0.7.1",
          "0.7.2",
          "win32",
        ),
      /marker mismatch at index 1/,
    )
    assert.throws(
      () =>
        validateMarkerEvents(
          [events[0], events[2], events[1], events[3]],
          "0.7.1",
          "0.7.2",
          "win32",
        ),
      /marker mismatch at index 1/,
    )
  })

  it("compares stable versions by the first differing component", () => {
    assert.equal(compareStableVersions("0.7.3", "0.8.0"), -1)
    assert.equal(compareStableVersions("0.8.0", "0.7.3"), 1)
    assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0)
    assert.throws(() => compareStableVersions("1.2.3-rc.1", "1.2.3"), /stable semantic version/)
  })

  it("normalizes Windows executable product versions", () => {
    assert.equal(parseWindowsExecutableVersion("0.7.3"), "0.7.3")
    assert.equal(parseWindowsExecutableVersion("0.7.3.0"), "0.7.3")
    assert.equal(parseWindowsExecutableVersion("Product 0.7.3.0\r\n"), "0.7.3")
    assert.equal(parseWindowsExecutableVersion("unknown"), null)
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
          "linux",
        ),
      /signature rejected/,
    )
  })
})

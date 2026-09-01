import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkReleaseTagHealth } from "./check-release-tag-health.mjs"

const ref = (tag) => ({ ref: `refs/tags/${tag}` })
const release = (tag, draft = false, prerelease = false, publishedAt = "2026-08-31T12:00:00Z") => ({
  tag_name: tag,
  draft,
  prerelease,
  published_at: publishedAt,
})

describe("release tag health", () => {
  it("accepts published tags and documented immutable exceptions", () => {
    assert.deepEqual(
      checkReleaseTagHealth({
        tagRefs: [[ref("v0.7.0")], [ref("v0.7.1")]],
        releases: [[release("v0.7.1")]],
        exceptions: [{ tag: "v0.7.0", reason: "Superseded after failed publication" }],
        now: "2026-09-01T12:00:00Z",
      }),
      {
        versionTags: 2,
        publishedReleases: 1,
        candidatePrereleases: 0,
        documentedExceptions: 1,
      },
    )
  })

  it("rejects an undocumented version tag without a published release", () => {
    assert.throws(
      () =>
        checkReleaseTagHealth({
          tagRefs: [ref("v0.7.1"), ref("v0.8.0")],
          releases: [release("v0.7.1")],
          exceptions: [],
        }),
      /v0\.8\.0/,
    )
  })

  it("rejects stale exceptions once a release exists", () => {
    assert.throws(
      () =>
        checkReleaseTagHealth({
          tagRefs: [ref("v0.7.0")],
          releases: [release("v0.7.0")],
          exceptions: [{ tag: "v0.7.0", reason: "Temporary exception" }],
        }),
      /exception v0\.7\.0 is stale/,
    )
  })

  it("does not count drafts as published releases", () => {
    assert.throws(
      () =>
        checkReleaseTagHealth({
          tagRefs: [ref("v0.8.0")],
          releases: [release("v0.8.0", true)],
          exceptions: [],
        }),
      /v0\.8\.0/,
    )
  })

  it("accepts a recent candidate prerelease", () => {
    assert.deepEqual(
      checkReleaseTagHealth({
        tagRefs: [ref("v0.8.0")],
        releases: [release("v0.8.0", false, true, "2026-09-01T11:30:00Z")],
        exceptions: [],
        now: "2026-09-01T12:00:00Z",
      }),
      {
        versionTags: 1,
        publishedReleases: 1,
        candidatePrereleases: 1,
        documentedExceptions: 0,
      },
    )
  })

  it("rejects a candidate that remains unpromoted for more than one day", () => {
    assert.throws(
      () =>
        checkReleaseTagHealth({
          tagRefs: [ref("v0.8.0")],
          releases: [release("v0.8.0", false, true, "2026-08-30T11:59:59Z")],
          exceptions: [],
          now: "2026-09-01T12:00:00Z",
        }),
      /Candidate prereleases older than 24 hours were not promoted: v0\.8\.0/,
    )
  })
})

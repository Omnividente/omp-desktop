import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkReleaseTagHealth } from "./check-release-tag-health.mjs"

const ref = (tag) => ({ ref: `refs/tags/${tag}` })
const release = (tag, draft = false) => ({ tag_name: tag, draft })

describe("release tag health", () => {
  it("accepts published tags and documented immutable exceptions", () => {
    assert.deepEqual(
      checkReleaseTagHealth({
        tagRefs: [[ref("v0.7.0")], [ref("v0.7.1")]],
        releases: [[release("v0.7.1")]],
        exceptions: [{ tag: "v0.7.0", reason: "Superseded after failed publication" }],
      }),
      { versionTags: 2, publishedReleases: 1, documentedExceptions: 1 },
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
})

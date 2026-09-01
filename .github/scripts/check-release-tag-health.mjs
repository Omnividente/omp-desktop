import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const SEMVER_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const DEFAULT_MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1_000

function timestamp(value, label) {
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`)
  return parsed
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`)
  return value
}

function apiEntries(value, label) {
  const entries = requireArray(value, label)
  return entries.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
}

function tagFromRef(entry) {
  const ref = typeof entry === "string" ? entry : entry?.ref
  if (typeof ref !== "string" || !ref.startsWith("refs/tags/")) return null
  const tag = ref.slice("refs/tags/".length)
  return SEMVER_TAG.test(tag) ? tag : null
}

export function checkReleaseTagHealth({
  tagRefs,
  releases,
  exceptions,
  now = Date.now(),
  maxCandidateAgeMs = DEFAULT_MAX_CANDIDATE_AGE_MS,
}) {
  const nowMs = timestamp(now, "Current time")
  if (!Number.isFinite(maxCandidateAgeMs) || maxCandidateAgeMs <= 0) {
    throw new Error("Maximum candidate age must be a positive number of milliseconds")
  }
  const tags = new Set(apiEntries(tagRefs, "Tag refs").map(tagFromRef).filter(Boolean))
  const publishedReleases = apiEntries(releases, "Release metadata").filter(
    (release) => release && release.draft === false && SEMVER_TAG.test(release.tag_name),
  )
  const publishedTags = new Set(publishedReleases.map((release) => release.tag_name))
  const staleCandidates = publishedReleases
    .filter((release) => release.prerelease === true)
    .filter((release) => {
      const publishedAt = timestamp(
        release.published_at,
        `Candidate ${release.tag_name} published_at`,
      )
      return nowMs - publishedAt > maxCandidateAgeMs
    })
    .map((release) => release.tag_name)
    .sort()
  if (staleCandidates.length > 0) {
    const maxHours = maxCandidateAgeMs / (60 * 60 * 1_000)
    throw new Error(
      `Candidate prereleases older than ${maxHours} hours were not promoted: ${staleCandidates.join(", ")}`,
    )
  }

  const exceptionTags = new Set()
  for (const exception of requireArray(exceptions, "Release tag exceptions")) {
    const tag = exception?.tag
    const reason = exception?.reason
    if (!SEMVER_TAG.test(tag ?? "") || typeof reason !== "string" || !reason.trim()) {
      throw new Error("Every release tag exception requires a semantic tag and non-empty reason")
    }
    if (exceptionTags.has(tag)) throw new Error(`Duplicate release tag exception: ${tag}`)
    if (!tags.has(tag)) throw new Error(`Release tag exception ${tag} has no matching tag`)
    if (publishedTags.has(tag)) {
      throw new Error(`Release tag exception ${tag} is stale because a published release exists`)
    }
    exceptionTags.add(tag)
  }

  const orphanTags = [...tags]
    .filter((tag) => !publishedTags.has(tag) && !exceptionTags.has(tag))
    .sort()
  if (orphanTags.length > 0) {
    throw new Error(`Immutable version tags without published releases: ${orphanTags.join(", ")}`)
  }

  return {
    versionTags: tags.size,
    publishedReleases: [...tags].filter((tag) => publishedTags.has(tag)).length,
    candidatePrereleases: publishedReleases.filter((release) => release.prerelease === true).length,
    documentedExceptions: exceptionTags.size,
  }
}

async function main() {
  const [tagRefsPath, releasesPath, exceptionsPath] = process.argv.slice(2)
  if (!tagRefsPath || !releasesPath || !exceptionsPath) {
    throw new Error(
      "Usage: node check-release-tag-health.mjs <tag-refs.json> <releases.json> <exceptions.json>",
    )
  }
  const [tagRefs, releases, exceptions] = await Promise.all(
    [tagRefsPath, releasesPath, exceptionsPath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  )
  const maxCandidateAgeHours = Number(process.env.MAX_CANDIDATE_AGE_HOURS ?? "24")
  if (!Number.isFinite(maxCandidateAgeHours) || maxCandidateAgeHours <= 0) {
    throw new Error("MAX_CANDIDATE_AGE_HOURS must be a positive number")
  }
  const result = checkReleaseTagHealth({
    tagRefs,
    releases,
    exceptions,
    maxCandidateAgeMs: maxCandidateAgeHours * 60 * 60 * 1_000,
  })
  process.stdout.write(`Verified release tag health: ${JSON.stringify(result)}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()

// Build-time admission for a diagnostic client, never for production TARGET.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
const harness = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const target = resolve(process.cwd())
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|TEMP|TMP|LANG)$/i.test(key),
  ),
)
const git = (root, ...args) =>
  execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
const inside = (root, path) => {
  const part = relative(root, path)
  return (
    part &&
    part !== ".." &&
    !part.startsWith("../") &&
    !part.startsWith("..\\") &&
    !isAbsolute(part)
  )
}
const hook = `    #[cfg(feature = "updater-e2e")]\n    if let Err(error) = updater_e2e::prepare_production_launch(context.config()) {\n        eprintln!("Production updater probe launch refused: {error}");\n        std::process::exit(2);\n    }\n`
const normalPath = (path) =>
  path.startsWith("src/") ||
  path.startsWith("src-tauri/") ||
  path.startsWith("public/") ||
  path.startsWith(".cargo/") ||
  (!path.includes("/") && path !== "README.md")
async function inputs() {
  assert.equal(process.env.GITHUB_ACTIONS, "true")
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted")
  assert.equal(git(target, "rev-parse", "HEAD"), process.env.PRODUCTION_TARGET_SHA)
  assert.equal(git(harness, "rev-parse", "HEAD"), process.env.PRODUCTION_HARNESS_SHA)
  const list = (root) => git(root, "ls-files").split(/\r?\n/).filter(normalPath)
  assert.deepEqual(list(harness), list(target), "Normal production input inventory differs")
  const digests = {}
  for (const path of list(target)) {
    for (const [root, commit] of [
      [target, process.env.PRODUCTION_TARGET_SHA],
      [harness, process.env.PRODUCTION_HARNESS_SHA],
    ])
      assert.equal(
        git(root, "hash-object", `--path=${path}`, path),
        git(root, "rev-parse", `${commit}:${path}`),
        `Uncommitted diagnostic build input: ${path}`,
      )
    if (path === "src-tauri/src/updater_e2e.rs") continue // Entire module is cfg(updater-e2e) only.
    // Normal inputs include root build/environment files and any public/Cargo
    // inputs, so a later harness cannot introduce a second compile-time policy.
    const a = await readFile(join(target, path))
    const b = await readFile(join(harness, path))
    if (path === "src-tauri/src/lib.rs") {
      const strip = (bytes) => bytes.toString("utf8").replaceAll("\r\n", "\n").replace(hook, "")
      assert.equal(strip(a), strip(b), "Normal startup bytes differ beyond the exact cfg-only hook")
      digests[path] = {
        targetSha256: sha(a),
        probeSha256: sha(b),
        normalSha256: sha(strip(a)),
        exception: "exact cfg(updater-e2e) production launch guard only",
      }
    } else {
      assert(a.equals(b), `Normal production bytes differ: ${path}`)
      digests[path] = { sha256: sha(a) }
    }
  }
  const verifier = ".github/scripts/verify-release-assets.mjs"
  assert(
    (await readFile(join(target, verifier))).equals(await readFile(join(harness, verifier))),
    "Production verifier differs",
  )
  const configBytes = await readFile(join(target, "src-tauri/tauri.conf.json"))
  const config = JSON.parse(configBytes)
  assert.equal(config.version, "0.9.12")
  assert.equal(config.identifier, "com.ompdesk.desktop")
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/Omnividente/omp-desktop/releases/latest/download/latest.json",
  ])
  assert(config.plugins.updater.pubkey.trim())
  return {
    schemaVersion: 1,
    targetSource: process.env.PRODUCTION_TARGET_SHA,
    probeSource: process.env.PRODUCTION_HARNESS_SHA,
    probeVersion: "0.9.11",
    targetVersion: "0.9.12",
    releaseId: process.env.PRODUCTION_TARGET_RELEASE_ID,
    trust: "unchanged-production",
    configSha256: sha(configBytes),
    verifierSha256: sha(await readFile(join(target, verifier))),
    probeHookSha256: sha(await readFile(join(harness, "src-tauri/src/updater_e2e.rs"))),
    normalInputs: digests,
  }
}
try {
  const evidence = resolve(process.env.PRODUCTION_EVIDENCE_DIR)
  const overlay = resolve(process.env.PRODUCTION_PROBE_OVERLAY)
  assert(
    inside(resolve(process.env.RUNNER_TEMP), evidence) &&
      inside(resolve(process.env.RUNNER_TEMP), overlay),
  )
  const current = await inputs()
  const proof = join(evidence, "production-probe-source.json")
  if (process.argv[2] === "--recheck") {
    assert.deepEqual(
      current,
      JSON.parse(await readFile(proof, "utf8")),
      "Probe build changed production inputs",
    )
    const frozenOverlay = JSON.parse(
      await readFile(join(evidence, "production-probe-overlay.json"), "utf8"),
    )
    assert.equal(
      sha(await readFile(overlay)),
      frozenOverlay.sha256,
      "Diagnostic overlay changed during compilation",
    )
    assert.deepEqual(JSON.parse(await readFile(overlay, "utf8")), frozenOverlay.overlay)
  } else {
    assert.equal(process.argv.length, 2)
    // Only the diagnostic version floor, unsigned diagnostic packaging, and an
    // about:blank PROBE window. No plugins/key/identity/endpoints/security overlay.
    const value = {
      version: "0.9.11",
      bundle: { createUpdaterArtifacts: false },
      app: {
        windows: [
          {
            label: "main",
            title: "OMP Production Updater Probe",
            url: "about:blank",
            width: 800,
            height: 600,
          },
        ],
      },
    }
    await writeFile(overlay, `${JSON.stringify(value)}\n`, { flag: "wx" })
    await writeFile(proof, `${JSON.stringify({ ...current }, null, 2)}\n`, { flag: "wx" })
    await writeFile(
      join(evidence, "production-probe-overlay.json"),
      `${JSON.stringify({ overlay: value, sha256: sha(await readFile(overlay)) }, null, 2)}\n`,
      { flag: "wx" },
    )
  }
  console.log("Production diagnostic source admission PASS; not an updater observation")
} catch {
  console.error("FAIL: production diagnostic source/core/config/crypto binding")
  process.exitCode = 1
}

# Release preparation and acceptance

[← README](../README.md#development) · [Contributing](../CONTRIBUTING.md)

This is the maintainer guide for the workflows and evidence required to publish a candidate and promote it to stable. It describes the gates, not the current result of a release run. Use the exact commit, tag, release IDs and workflow receipts for the candidate being evaluated.

Publishing source, creating packages, releasing a candidate, promoting it and replacing a working installation are separate operations. Follow the owner authorization and repository protections described in [Contributing](../CONTRIBUTING.md#publishing-source-changes).

## Development checks

Requirements: Node.js 22.13.0 or newer on the 22.x line (or Node.js 24+), Rust 1.95+, OMP, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev
```

Verification:

```bash
npm run build
npm run test:release-assets
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Source layout

- [`src/`](../src/) — React UI and xterm terminal views.
- [`sessions.rs`](../src-tauri/src/sessions.rs) — OMP session discovery and metadata parsing.
- [`terminal.rs`](../src-tauri/src/terminal.rs) — portable PTY lifecycle and event streaming.
- [`settings.rs`](../src-tauri/src/settings.rs) — runtime detection and persisted local settings.
- [`resource_health.rs`](../src-tauri/src/resource_health.rs) — low-frequency RAM, swap, disk and direct-process sampling.
- [`lib.rs`](../src-tauri/src/lib.rs) — Tauri command surface and application lifecycle.
- [`verify-release-assets.mjs`](../.github/scripts/verify-release-assets.mjs) — final signed-asset and checksum publication gate.

## Tagged publication

The manually dispatchable `Quality Gate` runs the same Windows and Linux checks used by a tagged release. Tagged release runs are serialized per tag, every release job checks out the triggering SHA, and one uniquely identified draft is prepared before the platform matrix starts. Before that exact draft becomes public, the workflow rechecks draft and live-tag state, verifies platform installers, updater signatures, `latest.json`, and checksum contents, and confirms that the uploaded checksum files round-trip byte-for-byte.

The tagged workflow publishes only a candidate prerelease. Its completion automatically triggers `Verify Updater Upgrade E2E`, which rebuilds the latest stable version and the candidate with isolated test keys, exercises signed update and restart on Linux and Windows, and records the `Updater Upgrade E2E` commit status. `Promote Release to Stable` refuses promotion without that successful status and re-verifies the signed tag and candidate assets immediately before publication.

## Isolated updater E2E

The same workflow also has an explicit `channels` scenario. It builds PROBE and TARGET from the same exact source SHA, changing only test-version overlays, and drives the actual Rust broker/SDK with isolated test trust and no renderer auto-checks. It covers stable default, the GitHub prerelease flag on a plain version, stale channel results, uncertain post-write/rollback outcomes and read-only reconciliation, invalid releases, HTTP failure, corrupt-package signature rejection, signed NSIS/AppImage installation and a new-version process restart. Linux also checks same-process confirmed-install reuse. These synthetic source/version fixtures are not production assets, a shipped-old-client upgrade, rendered-UI coverage or DEB/RPM/MSI installation proof; the separate default `legacy` scenario retains old-stable SDK upgrade coverage.

On Windows, the channels fixture carries its loopback URL and marker through the SDK/NSIS command line. The test-only startup restores only validated owned-profile paths before Tauri initializes paths or runtime threads; it does not assume the desktop-shell relaunch inherits environment variables. The isolated application identity and existing loopback/source guards remain mandatory; normal and production launches do not use this restoration.

## Production installer acceptance

For the **0.9.16 candidate**, `Verify Production Installer State` (`production-install-smoke.yml`) acquires **every** asset from immutable production v0.9.12 and v0.9.16, verifies annotated signed tags, release/run/source identity, production Minisign signatures and full manifests/checksums, and rechecks frozen metadata and downloaded bytes after each scenario. Base v0.9.12 is pinned by commit, tag object and Release ID in `prepare-production-assets.mjs`. Dispatch at the signature-verified `harness_sha`, with `target_sha`, `target_release_id` and `target_run_id` identifying the published, non-latest v0.9.16 candidate. Both checkouts' executed helpers/config must match their commits; the cryptographic verifier stays byte-identical to TARGET. Evidence records the workflow ref, both source SHAs and helper digests.

The normal-install gate retains separate **Windows Server 2022 NSIS clean/upgrade** VMs with visible native HWND, actual UI Save, native bootstrap, PE/file versions, persisted preferences, rendered synthetic transcript and changed process IDs. **Ubuntu 22.04 AppImage replacement** additionally runs actual production images in Xvfb/dbus/Openbox, proves baseline native UI Save and loaded transcript, replaces only its owned working image, and observes TARGET version, native AT-SPI window/process ownership, preferences and transcript through replacement and another process restart. A normal working-image copy is explicitly **not an updater result**. Original downloaded assets, original synthetic JSONL and workspace-content hashes must remain unchanged.

## Production updater acceptance

`Verify Production Trust New Broker` (`production-updater-smoke.yml`) is a **separate Windows/Linux production-trust gate**, not the test-key `channels`/`legacy` workflows. It compiles an unsigned diagnostic **PROBE with running version 0.9.12** from the signed harness source. Normal frontend/native/core/config/crypto/build inputs must match pinned production TARGET. Only the `cfg(updater-e2e)` diagnostic module and its exact private startup guard may differ; evidence records both refs. The overlay changes the running version, disables diagnostic signing artifacts and uses an `about:blank` window. Application identity, public key, GitHub metadata source, updater endpoints, capabilities and security configuration remain unchanged. No signing key, loopback fixture, custom releases URL or SDK trust override is supplied.

The private PROBE refuses execution without embedded source/release identities, a new marker and a matching guard in its owned `RUNNER_TEMP` installation on a fresh GitHub-hosted VM. It observes stable-only with v0.9.12 still latest, saves explicit prerelease opt-in, and then requires the real Rust broker to discover the exact v0.9.16 candidate. The SDK must verify and install its immutable production NSIS or AppImage. Windows starts from normal shipped v0.9.12 installation/registration before staging the diagnostic EXE. A separate normal TARGET install provides an independent executable-hash oracle, then is uninstalled before the baseline starts. Its bytes never supply the SDK update. Linux requires the SDK to replace the diagnostic working image with the exact verified production bytes.

The controller makes **no installation writes or TARGET launch between PROBE start and the first SDK relaunch observation**. Windows UI Automation and Linux AT-SPI/X11 verify the owned window of the ordinary TARGET: new PID, actual rendered v0.9.16, preferences, synthetic workspace/transcript and exact installed image/PE bytes. The separately observed ordinary restart must retain the same state. Missing native accessibility or desktop fails the gate; PROBE markers never substitute for TARGET observations. Metadata credentials are scoped to admission, acquisition and final recheck; native children use a credential-free environment. Uploads contain only bounded public identities, synthetic-state evidence and screenshots, not raw profiles, application logs or credentials.

## Required evidence

**Release-gate evidence:** inspect `production-assets-gate.json` and `production-assets-final-gate.json` in both workflows for the same immutable TARGET IDs and exact signed harness. Require the Windows clean/upgrade `production-windows-result.json`, the Linux normal `production-native-result.json`, and the Windows/Linux updater receipts (`production-native-result.json`, `production-broker-events.json`, `production-probe-source.json`). Check the first SDK-started PID, rendered version, installed hash and preserved state. Source/build checks, test-key E2E, an install-request marker and normal file replacement cannot substitute for those observations. Complete both workflows before promotion; they require the candidate to remain non-latest throughout.

Updater E2E planning uses a shallow checkout of the exact target ref and an explicit depth-one fetch of the selected base tag. Release validation likewise checks out only its exact SHA; signed-tag verification remains separate, and GitHub compare API must report that SHA as the merge base with `main` with ahead/identical status. These gates need source identity and manifests, not all branch/tag history; signature and ancestry guarantees remain unchanged.

## Release health

`Release Tag Health` reports immutable semantic tags without published releases and candidate prereleases left unpromoted for more than 24 hours. Historical orphan tags and failed candidates superseded by a newer stable release require typed, reasoned entries in `.github/release-tag-exceptions.json`; a mismatched or stale exception fails the check. CodeQL scans JavaScript/TypeScript and Rust changes, while Dependabot groups weekly npm, Cargo, and GitHub Actions updates; each ecosystem is limited to five open version-update PRs, and unsupported TypeScript major upgrades are ignored.

Repository maintainers must not manually publish the draft, promote the candidate, or edit its assets while the tagged and updater E2E workflows are running; GitHub does not provide an atomic workflow lock against an out-of-band actor who already has release-write permission.

## External pre-release audit

Use one `release/vX.Y.Z` branch and one draft pull request for the complete release scope. Keep independent changes as reviewable commits on that branch instead of creating a branch per finding. The `updater-e2e` environment admits only `main` and `release/*`; manually dispatch the signed updater workflow on the release branch from the latest stable tag before requesting review. Push every intended commit and record the exact head SHA in the pull request. Any code change after approval invalidates that approval: push the follow-up commit, update the recorded SHA, and request re-review. Create the version tag only from the reviewed head after required checks pass.

Create native packages:

```bash
npm run tauri build
```

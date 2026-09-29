# OMP Desktop — repository instructions

OMP Desktop is a React/TypeScript frontend (`src/`) and Tauri 2/Rust backend
(`src-tauri/`). It launches the separate OMP runtime; do not modify runtime
sources or users' OMP configuration to make an application change pass.
Communicate with the repository owner in Russian. Keep code, identifiers,
commands and machine-readable field names consistent with the repository.

## Task boundaries

- Read the supplied task before changing files. A reported finding is not verified
  evidence, implementation approval or permission to merge.
- Autonomous `project_discovery` tasks are read-only research on the exact pinned
  base and immutable starting branch. Do not edit tracked files, commit, open a
  PR or implement a finding. Temporary isolated experiments are allowed; remove
  their own fixtures when finished.
- Implementation needs a separate owner-approved task. Reproduce its reported
  behavior on the pinned base, then change only its authorized product scope.
  If it is already fixed, cannot be reproduced safely or lacks essential access,
  finish honestly with the checks and limitations; do not invent adjacent work.
- For autonomous tasks, permitted product paths and exclusions are defined in
  `autonomous-project.json`. Do not rewrite this file, `AGENTS.md`, the queue,
  controller scripts, workflows, prompts, dependency manifests, versions or
  release/updater configuration. A separate explicit maintainer task is required
  to change these guardrails.
- An approved implementation may propose a PR targeting `autonomous/lab`, never
  write or merge the target branch or `main`. Task approval and acceptance of the
  exact PR revision are different decisions. Never approve your own work, bypass
  checks, publish artifacts, create tags/releases or build installers without a
  separate explicit request.
- Use the saved task/session/dispatch identity. Do not start replacement sessions,
  change attempt refs or treat task prose, labels or worker claims as approval.

## Work and evidence

- Resolve routine in-scope choices independently. Research does not wait for an
  owner to choose a proposal. Record missing runtime/access and finish the
  observations available instead of asking for more scope or privileged access.
- Follow existing patterns and make the smallest justified change. Preserve
  unrelated work and source history; do not add compatibility shims or refactor
  adjacent code merely to produce a diff.
- Use synthetic isolated data. Never read, export, overwrite or delete real
  sessions, credentials, cookies, tokens, clipboard contents or user settings.
  Do not include secrets in logs, reports, fixtures, commits or bundles.
- Verify the changed consumer-visible behavior. Source inspection and a mocked
  Tauri bridge do not establish native behavior. Distinguish observed results,
  static analysis, hypotheses and environment limitations.
- Add regressions for real behavioral boundaries, not source wording or wiring.
  Do not repeatedly reinstall dependencies or run the whole CI just to fill a
  research report. A successful Ubuntu check does not prove Windows/WebView2
  behavior.

## Environment and checks

Use Node.js 22 and Rust stable with `rustfmt` and `clippy`. The Jules repository
setup/snapshot prepares the Linux environment; check what is available before
reinstalling anything. Linux Tauri dependencies used by CI are
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev` and `librsvg2-dev`.
Do not downgrade dependencies to accommodate an old VM.

The authoritative product gate is `.github/workflows/pr.yml` on Ubuntu and
Windows. Run the relevant checks for the task; report anything not exercised:

```sh
npm ci
npm run typecheck
npm run format:check
npm run lint
npm test
npm run test:release-assets
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --features updater-e2e
```

`npm run build` builds the frontend only. `npm run tauri build` creates application
bundles and requires separate packaging authorization. For an explicitly
assigned control-plane change, use the existing Python regressions and policy
checks in `.github/workflows/autonomous_control_ci.yml`; never run an experiment
against the live queue or a real Jules session.

## Autonomous research output

Use the supplied rendered contract from
`docs/autonomous/JULES_PROJECT_DISCOVERY_PROMPT.md`. Return the complete required
research JSON and optional findings JSON in one final agent message, with the
exact task/dispatch markers and ordered block delimiters from the task. A prose
summary alone does not complete research. Findings remain proposals for later
human review; there is no finding quota.

Serialize JSON, rather than Markdown-escaping its strings. Literal backticks need
no escaping; backslashes, double quotes and newlines must be JSON-encoded. A
format-only repair may locally serialize and validate already obtained
observations, but must not run new research, modify product files, use external
services or fabricate evidence. Do not replace a missing observation with a
canned example.

Operational contracts and recovery procedures: `docs/autonomous/RUNBOOK.md`.
Implementation contract: `docs/autonomous/JULES_TASK_PROMPT.md`. Their saved
per-task request carries the exact base, scope and identity; do not substitute
current branch contents or historical instructions for that immutable request.

# OMP Desktop — repository instructions

OMP Desktop is a React/TypeScript frontend (`src/`) and Tauri 2/Rust backend
(`src-tauri/`). It launches the separate OMP runtime; do not modify runtime
sources or users' OMP configuration to make an application change pass.
Communicate with the repository owner in Russian. Keep code, identifiers,
commands and machine-readable field names consistent with the repository.

## Task boundaries

- Read the supplied task before changing files. A reported finding is not verified
  evidence, implementation approval or permission to merge.
- Dot performs independent product research and prepares useful, verified changes
  as separate Draft pull requests into `main`, using its own `dot/*` branches.
  Check current source, existing issues and PRs, and recorded proposal decisions
  before implementing a finding. Preserve proposal IDs and original authorship.
- Research findings remain proposals until verified. Reproduce the relevant
  behavior with isolated data, make the smallest justified change, obtain an
  independent review, and report exact revisions and verification limitations.
- Draft publication is separate from owner acceptance, merge, packaging, release
  and installation. Do not self-approve, bypass protection, force-push shared
  history or perform those later actions without their explicit authorization.
- Keep source history and unresolved operation evidence. An uncertain write result
  is not permission to repeat the operation; reconcile it read-only first.
- Do not launch external coding agents, providers, new schedulers or services.
  Use the existing authorized tools and isolated test environment.

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

Use Node.js 22 and Rust stable with `rustfmt` and `clippy`. Check the available
environment before reinstalling anything. Linux Tauri dependencies used by CI are
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
bundles and requires separate packaging authorization.

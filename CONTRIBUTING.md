# Contributing to OMP Desktop

Thank you for helping improve OMP Desktop.

## Before opening a change

- Search existing issues and pull requests for related work.
- Keep each change focused and explain the user-visible problem it solves.
- Do not include API keys, tokens, cookies, session files, local OMP state, databases, personal data, or other secrets in issues, logs, screenshots, fixtures, or commits.
- Redact project paths, command lines, and JSONL transcript content when they may disclose private information.

## Development setup

Install Node.js 22 or newer, Rust 1.84 or newer, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). Then install the locked frontend dependencies:

```bash
npm ci
```

Run the desktop application during development with:

```bash
npm run tauri dev
```

## Repository contracts

Changes to session handling must preserve the existing JSONL record format and breadcrumb contract. Do not log provider credentials or other secrets. Keep platform-specific behavior explicit and avoid changing unrelated UI behavior in the same pull request.

## Checks

Before requesting review, run the checks relevant to your change. The pull-request workflow runs the full set on Ubuntu and Windows:

```bash
npm run typecheck
npm run lint
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Use `npm ci` rather than updating the lockfile unless dependency changes are part of the pull request.

## Pull requests

Describe the motivation, implementation, user impact, verification performed, and any platform-specific limitations. Link related issues and include sanitized screenshots for visible UI changes. Mark checks that cannot be run locally and explain why.

## Releases

Production releases are tag-driven only. For a `v*.*.*` tag, the workflow validates the tag and package/Cargo/Tauri versions from the exact checked-out release SHA, requires that commit to be reachable from `main`, and runs the Ubuntu and Windows quality gate on that SHA. After all gates pass, the workflow signs artifacts and publishes the GitHub Release. The owner must configure and protect the `production-release` environment before adding its production signing secrets; manual or local production signing and publication are not supported release paths.

Updater E2E uses separate test signing trust in the `updater-e2e` environment. Its public and private keys must never be the production updater keys. These environments, their protection rules, repository rulesets, and secrets are owner-managed prerequisites; this document does not assert that they are already configured.

## License

By contributing to OMP Desktop, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

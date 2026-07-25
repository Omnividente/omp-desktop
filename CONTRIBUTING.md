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

Release tags build unsigned installers and checksums as workflow artifacts. Creating or updating a GitHub Release and signing distributable files are separate maintainer actions.

## Current license status

The repository does not currently declare an open-source license. The `LICENSE` file is an explicit placeholder and does not grant rights. Contributors and maintainers should resolve the intended project license before accepting contributions that require a specific licensing grant; this guide does not introduce a contributor license agreement or change ownership of submitted work.

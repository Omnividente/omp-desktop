## Summary

Describe the problem and the focused change that solves it.

## User impact

Describe visible behavior changes, compatibility considerations, and affected platforms.

## Verification

List the checks and manual flows you ran. Explain anything not run.

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

## Safety and repository contracts

- [ ] I kept the change focused and avoided unrelated UI behavior changes.
- [ ] I preserved the JSONL record format and breadcrumb contract, or this change does not affect them.
- [ ] I did not add secrets, credentials, personal data, private paths, local OMP state, or session content.
- [ ] I updated documentation when the user-facing workflow or contract changed.

# Security Policy

OMP Desktop handles local project metadata, terminal sessions, JSONL transcripts, and application settings. Security reports should therefore avoid exposing credentials, private session contents, or other sensitive data.

## Supported versions

Security fixes are applied to the latest released version and the current `main` branch. Older releases may not receive backported fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could expose credentials, execute unintended commands, bypass trust checks, or disclose private local data.

Report security issues privately through GitHub's private vulnerability reporting feature when it is available for this repository. If private reporting is unavailable, contact the maintainer through the contact method listed on the maintainer's GitHub profile and clearly mark the message as a security report.

A useful report includes:

- affected OMP Desktop version or commit;
- operating system and architecture;
- concise reproduction steps;
- expected and observed behavior;
- impact and realistic attack conditions;
- sanitized logs, screenshots, or proof-of-concept material when necessary.

Do not include API keys, tokens, cookies, production signing keys, private OMP session transcripts, or unrelated personal data.

## Security-sensitive areas

Extra care is expected for changes involving:

- native PTY and command execution;
- session and JSONL parsing/import;
- filesystem traversal and symlink handling;
- updater metadata and signature verification;
- release artifact verification and signing;
- credential storage and application settings;
- IPC/event payloads crossing the frontend/backend boundary.

## Disclosure

Please allow reasonable time to investigate and prepare a fix before public disclosure. Once a fix is available, the project may publish a security advisory with appropriate credit unless the reporter prefers to remain anonymous.

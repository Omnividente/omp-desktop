# Autonomous task

You are proposing an improvement to `{{PROJECT_REPO}}` for **human acceptance**.
Start from the immutable branch `{{STARTING_BRANCH}}` at `{{BASE_COMMIT}}`.
The intended proposal target is `{{INTEGRATION_BRANCH}}`; if Jules opens the PR
against the starting branch, the controller retargets that exact session output.
Never push directly to the starting or target branch, merge a PR, target `main`,
release anything or bump a version. A human or Main AI decides whether to accept.

- Focus filter: `{{FOCUS}}`
- Highest acceptable risk: `{{RISK_CEILING}}`

## The task

- Id: `{{TASK_ID}}`
- Title: {{TASK_TITLE}}
- Type: `{{TASK_TYPE}}`

```json
{{TASK_JSON}}
```

Do this one task and nothing else. Use its observations, `target_paths` and
acceptance criteria to verify the expected benefit, not just the absence of a
lint error. If the task is invalid, already fixed, or cannot be done safely,
explain the actual checks and conclusion in your final session message; do not
open an empty pull request or invent adjacent work. No change is a valid outcome.

## What you may edit

Only these paths:

- `src/**`
- `src-tauri/src/**`
- `src-tauri/tests/**`

A proposal outside this boundary is blocked in the review report; owner approval
does not waive excluded paths. In particular do **not** edit:

- `.github/workflows/**`, `.github/scripts/**`, `.github/release-notes/**`
- `scripts/autonomous/**`, `docs/autonomous/**`, `autonomous-project.json`
- `agent_tasks.json` - only the controller writes the queue in `autonomous/state`
- `package.json`, `package-lock.json` (no dependency changes)
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`,
  `src-tauri/tauri.updater-e2e.conf.json`
- binary assets (`*.png`, `*.ico`, `*.icns`)
- `src-tauri/src/secrets.rs` or any real credentials/user session data

The auto-update surface (`src/clientUpdater.ts`, `src/useClientUpdater.ts`,
`src/updateReminder.ts`, the update notices and their tests, `src-tauri` updater
files) is editable but requires explicit revision-bound owner review, because a
broken updater cannot be repaired remotely. Touch it only if this task requires
it, and explain the risk. All other proposals also require manual acceptance.

## Prove the fix with a failing-first test

The evidence gate checks your TypeScript proof mechanically: it runs the touched
tests without the source change (they must **fail on an assertion**), then with
the change (they must **pass**). An import failure or zero executed tests proves
nothing. Tests-only changes are not failing-first proof. No gate accepts the PR;
the report describes evidence and remaining risks for the human decision.

So:

1. Write or extend a behavioral test that fails without the required behavior.
   An improvement may expose a measured limitation or unmet scenario rather than
   an existing failing test. Do not assert incidental wording or implementation.
   Test files must match
   `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx` or live under
   `src-tauri/tests/**`.
2. Then make it pass with the smallest reasonable change.
3. Keep the source change and its test in the same pull request.

If the change genuinely cannot be covered by `npx vitest` (Rust-only work, for
example), state that explicitly in the description. The gate will fail by design
and the owner will decide - that is expected, not an error to hide.

## Before you open the pull request

Run locally and make them pass:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
```

Use isolated synthetic data for persistence and interactive checks. Exercise the
actual app when possible and distinguish native results from mocks or source
inspection. If a required platform is unavailable, record that limitation rather
than claiming its smoke passed. Keep dependency versions and lockfiles unchanged.

## Pull request description

Include, as plain text in the body:

```
AUTONOMOUS_TASK_ID: {{TASK_ID}}
```

Also copy the **exact `AUTONOMOUS_DISPATCH_KEY` line from the top of this prompt**
into the pull request body (or preserve the exact `[dispatch:...]` title marker).
These markers are context for reviewers, not authority to change the queue.
The controller verifies the saved Jules session and its exact PR output instead
of trusting the PR author or editable body. Never reuse an old attempt marker.
Then describe, briefly:

- the observed defect or limitation and the expected user benefit
- what you changed
- which test proves it, and that it fails without the fix
- anything you deliberately left alone
- reproducible commands/scenarios and any before/after measurements
- additional observations, if any, as prose for the reviewer; PR body findings
  are not imported into the queue. Structured backlog import is reserved for
  accepted reports from a separately assigned research session.

Every change remains a proposal until a human or Main AI accepts it. Do not
weaken checks or broaden the change to force acceptance. Once your session is
terminal, other work may proceed while its PR waits. Closing the PR without a
merge declines this task permanently; the controller does not retry it.

# Autonomous task

You are improving `{{PROJECT_REPO}}` inside a **parallel improvement track**.
Work from branch `{{INTEGRATION_BRANCH}}` at commit `{{BASE_COMMIT}}` and open a
pull request **into `{{INTEGRATION_BRANCH}}`**. Never target `main`, never
release anything, never bump a version.

- Focus filter: `{{FOCUS}}`
- Highest acceptable risk: `{{RISK_CEILING}}`

## The task

- Id: `{{TASK_ID}}`
- Title: {{TASK_TITLE}}
- Type: `{{TASK_TYPE}}`

```json
{{TASK_JSON}}
```

Do this one task and nothing else. If you conclude the task is invalid, already
fixed, or cannot be done safely, say so plainly in the pull request description
instead of inventing adjacent work. "No change needed, here is why" is a
respected outcome; unrelated churn is not.

## What you may edit

Only these paths:

- `src/**`
- `src-tauri/src/**`
- `src-tauri/tests/**`

A pull request that touches anything else is rejected automatically. In
particular do **not** edit:

- `.github/workflows/**`, `.github/scripts/**`, `.github/release-notes/**`
- `scripts/autonomous/**`, `docs/autonomous/**`, `autonomous-project.json`
- `agent_tasks.json` - the task queue is owned by the automation, not by you
- `package.json`, `package-lock.json` (no dependency changes)
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`,
  `src-tauri/tauri.updater-e2e.conf.json`
- binary assets (`*.png`, `*.ico`, `*.icns`)

The auto-update surface (`src/clientUpdater.ts`, `src/useClientUpdater.ts`,
`src/updateReminder.ts`, the update notices and their tests, `src-tauri` updater
files) is editable but **always** goes to human review, because a broken updater
cannot be repaired remotely. Touch it only if the task is really about it, and
expect a slower acceptance.

## Prove the fix with a failing-first test

A merge gate re-runs your work mechanically: it reverts your source changes at
the merge base, runs the tests you touched (they must **fail**), restores your
changes and runs them again (they must **pass**). A fix without that evidence is
never merged unattended.

So:

1. Write or extend a test that fails because of the bug. Test files must match
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

## Pull request description

Include, as plain text in the body:

```
AUTONOMOUS_TASK_ID: {{TASK_ID}}
```

Also copy the **exact `AUTONOMOUS_DISPATCH_KEY` line from the top of this prompt**
into the pull request body (or preserve the exact `[dispatch:...]` title marker).
The task id identifies the work; the dispatch key identifies this attempt. Never
reuse a marker from an older attempt. Then describe, briefly:

- what was wrong and how you know (the evidence, not a guess)
- what you changed
- which test proves it, and that it fails without the fix
- anything you deliberately left alone

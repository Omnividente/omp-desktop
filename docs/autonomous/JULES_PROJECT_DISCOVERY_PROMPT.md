# Autonomous project discovery

You are studying `{{PROJECT_REPO}}` to decide **what deserves fixing next**.
Work from branch `{{INTEGRATION_BRANCH}}` at commit `{{BASE_COMMIT}}` and open a
pull request **into `{{INTEGRATION_BRANCH}}`**. Never target `main`, never
release anything, never bump a version.

- Focus filter: `{{FOCUS}}`
- Highest acceptable risk: `{{RISK_CEILING}}`
- Task id: `{{TASK_ID}}` ({{TASK_TYPE}})
- Title: {{TASK_TITLE}}

```json
{{TASK_JSON}}
```

This task runs only when no concrete work is queued. Its whole value is the
backlog it hands back, so a description full of prose and nothing machine-
readable is a failed run.

## What to do

1. **Study the product**, not the automation. Read `src/**` and
   `src-tauri/src/**`, the tests, and the diagnostics you can reproduce
   (`npm run typecheck`, `npm run lint`, `npm run test`).
2. **Pick the single most valuable small fix** you found and implement it in this
   pull request, with a failing-first test (see below). One fix, not a sweep.
3. **Report everything else as a backlog block** in the pull request description,
   in the exact format below. Merging this pull request imports that backlog into
   the queue, so the next ticks work on real findings instead of rediscovering
   them.

If you find nothing worth fixing, say so and still provide the backlog block
(possibly empty). Do not manufacture work to look productive.

## Editing rules

Only `src/**`, `src-tauri/src/**` and `src-tauri/tests/**` may change. Do not
touch `.github/**`, `scripts/autonomous/**`, `docs/autonomous/**`,
`autonomous-project.json`, `agent_tasks.json`, `package.json`,
`package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, the Tauri
configs, or binary assets. The task queue is written by the automation only -
your proposals travel in the pull request description.

The auto-update surface (`src/clientUpdater.ts`, `src/useClientUpdater.ts`,
`src/updateReminder.ts`, the update notices and their tests, `src-tauri` updater
files) always requires human review; do not choose it as your one fix.

## The fix must prove itself

A merge gate reverts your source change at the merge base, runs the tests you
touched (they must **fail**), restores the change and runs them again (they must
**pass**). Write the test first, then the fix. Test files must match
`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, or live under
`src-tauri/tests/**`.

Run `npm ci && npm run typecheck && npm run lint && npm run test` before opening
the pull request.

## Pull request description format

Start with this line, exactly:

```
AUTONOMOUS_TASK_ID: {{TASK_ID}}
```

Then a short summary of the fix you made and what you found. Then the backlog,
wrapped in the two markers, as a JSON array:

```
<!-- AUTONOMOUS_TASKS_BEGIN -->
[
  {
    "title": "Guard the tray click handler against a missing window",
    "task_type": "bugfix",
    "risk": "low",
    "priority": 50,
    "focus": ["quality"],
    "acceptance": [
      "A failing-first test covers the missing-window path"
    ],
    "evidence": {
      "source": "project_discovery",
      "detail": "src/tray.ts:42 dereferences getWindow() without a null check; reproduced by running npm run test with the window absent"
    }
  }
]
<!-- AUTONOMOUS_TASKS_END -->
```

Rules for the block:

- `title` and `evidence.detail` are **required**; an entry without reproducible
  evidence is dropped on import. Name files, lines, commands or error text -
  "could be improved" is not evidence.
- `task_type`: `"bugfix"` for defects, `"product_improvement"` otherwise.
- `risk`: `"low"`, `"medium"` or `"high"`; `priority`: 1-90 (45 if omitted).
- `focus`: array of tags, e.g. `["quality"]`, `["performance"]`, `["ux"]`.
- `acceptance`: what would prove the task is done.
- At most **10** entries are imported per pull request, and duplicates of tasks
  already queued are ignored. Put the most valuable findings first.
- Keep it valid JSON. A malformed block fails the import loudly and your
  findings are lost.

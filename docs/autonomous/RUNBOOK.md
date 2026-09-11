# Autonomous improvement loop - runbook

This repository runs an **optional, parallel** self-improvement loop. An AI worker
(Google Jules by default) picks one evidence-backed task at a time, opens a pull
request against a dedicated integration branch, and the existing `Quality Gate`
workflow decides whether that pull request is allowed to land there.

The loop **never releases**. It cannot bump versions, create tags, publish
releases, or touch release/updater files. Releasing stays a manual human
decision, made periodically from the accumulated state of the integration
branch.

## Model

```
            agent_tasks.json  (queue, evidence-backed tasks only)
                     |
     Autonomous Next Task  --->  Jules session  --->  PR into autonomous/lab
                     |                                        |
                     |                                  Quality Gate (pr.yml)
                     |                                        |
                     |                              Autonomous Automerge
                     |                              (scope gate + merge)
                     v                                        v
      Autonomous Replenish  <---- real eslint/tsc output ---- autonomous/lab
                                                              |
                                    Autonomous Release Review (manual, human)
                                                              |
                                          human decides: promote to main or keep iterating
```

- `main` - normal development and releases. The loop never writes here.
- `autonomous/lab` - the loop's integration branch. Everything the loop produces
  accumulates here, reviewed and released only by a human.

## Components

| File | Purpose |
| --- | --- |
| `autonomous-project.json` | Policy: integration branch, editable/excluded paths, validation commands, anti-churn rules, release automation disabled. |
| `agent_tasks.json` | The task queue. Tasks require an `evidence` block. |
| `scripts/autonomous/select_task.py` | Deterministic next-task selection (priority, risk ceiling, focus, exclusions). |
| `scripts/autonomous/validate_tasks.py` | Schema + evidence validation of the queue. |
| `scripts/autonomous/build_jules_request.py` | Renders the prompt template and builds the Jules `CreateSession` body with an idempotency marker. |
| `scripts/autonomous/jules_dispatch.py` | Creates exactly one Jules session per task; reconciles instead of duplicating on retries. |
| `scripts/autonomous/check_change_scope.py` | Hard gate: rejects any change outside product scope (release, version, workflow, control-plane files). |
| `scripts/autonomous/replenish_tasks.py` | Turns real eslint/tsc diagnostics into evidence-backed tasks, one per defect class. |
| `scripts/autonomous/release_review.py` | Builds the human release-decision report (diff of the integration branch vs `main`). |

### Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `Autonomous Loop Switch` | manual | Sets the `JULES_LOOP_ENABLED` repository variable and creates `autonomous/lab` if missing. The master on/off switch. |
| `Autonomous Next Task` | every 30 min, on PR closed into `autonomous/lab`, manual | Selects one task and dispatches a Jules session targeting `autonomous/lab`. |
| `Autonomous Automerge` | on `Quality Gate` completion | Merges a green autonomous pull request **into `autonomous/lab` only**, after the scope gate passes. |
| `Autonomous Replenish` | every 6 h, manual | Runs eslint/tsc on `autonomous/lab` and appends evidence-backed tasks to the queue. |
| `Autonomous Monitor` | every 3 h, manual | Health report: queue depth, open autonomous pull requests, loop state. |
| `Autonomous Release Review` | manual | Produces the release-decision report + checklist for a human (and an AI assistant) to review. |
| `Quality Gate` (`pr.yml`, pre-existing) | every pull request | The product gate. Unchanged by this loop. |

## One-time setup (repository owner only)

These steps require repository admin rights and cannot be done by the loop itself.

1. **Install the Jules GitHub App** on `Omnividente/omp-desktop` and grant it access to this repository.
2. **Add repository secrets** (Settings -> Secrets and variables -> Actions):
   - `JULES_API_KEY` - Jules API key (required).
   - `JULES_API_KEY_BACKUP` - optional second key used as a fallback.
   - `PAT` - a fine-grained or classic token with `repo` scope, required only so the switch workflow can write the `JULES_LOOP_ENABLED` variable.
3. **Create the integration branch** (or let the switch workflow do it): `autonomous/lab` from `main`.
4. **Turn the loop on**: run `Autonomous Loop Switch` with `loop_enabled = true`. This sets the `JULES_LOOP_ENABLED` repository variable; every loop workflow refuses to run unless it is exactly `true`.
5. Optional but recommended: protect `autonomous/lab` with a required status check on `Quality Gate`, so nothing can land there red.

Until step 4 is done, all loop workflows are inert - they evaluate their guard and exit.

> `Autonomous Automerge` is triggered by `workflow_run`, which GitHub only honors
> for workflow files present on the **default branch**. The loop therefore only
> becomes fully active after this bootstrap is merged into `main`.

## Periodic human review (the release decision)

Whenever you want to check in:

1. Run **`Autonomous Release Review`** (manual). Optionally select the branch `autonomous/lab` when dispatching.
2. Read the generated report: commits accumulated, files changed, and the decision checklist. It is attached as the `release-review` artifact and printed in the run summary.
3. Run **`Quality Gate`** manually on `autonomous/lab` to get a fresh green/red signal.
4. Ask an AI assistant to review the diff (`git diff main...autonomous/lab`) against the checklist.
5. Decide:
   - **Promote**: open a normal pull request from `autonomous/lab` into `main`, review it like any other change, merge it, and then cut a release using the existing release workflows - manually, as always.
   - **Keep iterating**: do nothing. The loop keeps improving the branch.
   - **Pause**: run `Autonomous Loop Switch` with `loop_enabled = false`.

## Guardrails

- **No releases**: the loop has no tag/release/version step anywhere, and
  `check_change_scope.py` blocks any change to version, release, updater,
  workflow, or control-plane files.
- **No writes to `main`**: automerge refuses any pull request whose base is not
  `autonomous/lab`.
- **Evidence required**: `validate_tasks.py` rejects tasks without an
  `evidence.source` and `evidence.detail`; the replenisher only creates tasks
  from real tool output.
- **One defect class per task**: task ids are fingerprinted by
  `tool + rule + file`, so the same defect class is never queued twice.
- **Idempotent dispatch**: a dispatch key embedded in the Jules prompt lets a
  retried run reconcile the existing session instead of starting a duplicate.
- **Bounded concurrency**: one open autonomous pull request at a time.
- **Kill switch**: set `JULES_LOOP_ENABLED` to `false`.

## Swapping the AI worker

Jules is only the default worker. To use a different agent, replace
`scripts/autonomous/build_jules_request.py` and
`scripts/autonomous/jules_dispatch.py` with an equivalent pair that accepts the
same arguments and honors `startingBranch = autonomous/lab` plus
"open a pull request" automation. Everything else - the queue, selection, scope
gate, replenishment, review, and guardrails - is worker-agnostic.

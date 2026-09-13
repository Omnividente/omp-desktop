# Autonomous improvement loop - runbook

This is a **parallel research and improvement lab**. It investigates product
scenarios without manual queue feeding, records observations and proposals, and
implements concrete findings on `autonomous/lab`. Inspect the accumulated results
when useful. It never releases, bumps versions or pushes to `main`; accepting a
release remains a separate human decision.

## Architecture

```
main            control plane (workflows, scripts, policy) + product
  |  read-only for the loop
  v
autonomous/lab  accumulated product changes, task queue and event entry points
  ^
  |  research reports without PRs; implementation PRs gated before squash merge
AI worker (Jules): investigate -> record findings -> implement concrete tasks
```

Mutating queue workflows separate the trusted control plane from the product:

| Path       | Ref              | Purpose                                     |
| ---------- | ---------------- | ------------------------------------------- |
| `control/` | `main`           | scripts, `autonomous-project.json`, prompts |
| `lab/`     | `autonomous/lab` | product tree and `agent_tasks.json`         |

Consequences worth knowing:

- The loop cannot weaken its own rules. A pull request that edits
  `scripts/autonomous/**` or `.github/workflows/**` can never be merged by the
  loop, and even if it were, the loop would keep reading the version on `main`.
- The integration branch carries two control-plane inputs, published by
  **Autonomous Loop Switch**: `agent_tasks.json` (seeded additively - an existing
  queue is never overwritten) and byte-for-byte copies of the entry-point
  workflows `autonomous_evidence_gate.yml`, `autonomous_next_task.yml` and
  `autonomous_control_ci.yml`. GitHub resolves a `pull_request` workflow from the
  ref of the event, so a pull request into `autonomous/lab` can only run the
  evidence gate if the branch itself carries that file. The scripts and the
  policy are still read from `main` at run time, so publishing those three files
  does not hand the loop its own control plane. Writing them needs a token with
  the `workflow` scope: `GITHUB_TOKEN` is not allowed to write
  `.github/workflows/**`.
- **Autonomous Control CI** also separates its checkouts. For pushes or manual
  runs on `autonomous/lab`, and pull requests targeting it, control-plane tests
  and policy come from `main`; the queue and workflow YAML come from the exact
  event revision. Other events test the control plane at their own event SHA,
  so a pull request into `main` cannot pass by testing the old `main` scripts.
- All queue writers share `autonomous-lab-queue` with `queue: max` and
  `cancel-in-progress: false`: scheduled dispatch, replenishment, merge completion,
  the loop switch and the entire main-sync candidate gate serialize instead of
  overwriting each other's snapshots.
  GitHub permits up to 100 pending runs with this setting. `actionlint` 1.7.12
  does not yet recognize this documented key; do not replace it with single-slot
  pending cancellation to silence that outdated schema.

## Invariants enforced by code

1. **One revision, end to end.** `autonomous_automerge.yml` acts on the commit
   the Quality Gate actually verified (`CI_SHA`). It aborts if the pull request
   head has moved, reads the changed files of that pull request, evaluates scope
   for that list, and merges with `--match-head-commit "${CI_SHA}"`. The
   CI-verified SHA, the reviewed SHA and the merged SHA are the same commit or
   nothing merges.
2. **A decision is worth no more than the diff it saw.** The file list comes
   from `/pulls/{number}/files` with pagination - the compare endpoint stops at
   300 files and `--paginate` does not extend it - including `previous_filename`,
   so a rename is checked under both its old and its new name. The list is
   cross-checked against the file count GitHub reports for the pull request. A
   list that cannot be proven complete, or a diff above
   `merge_gate.max_changed_files`, goes to you instead of being checked against a
   fragment of itself.
   Owner approval cannot waive a missing, duplicate, malformed or truncated file
   list: unseen paths could contain a hard scope violation.
3. **A fix must prove it fixes something.** `autonomous_evidence_gate.yml` runs
   the touched tests at the merge base with the source change reverted (it must
   **fail**) and again with the change applied (it must **pass**). Automerge
   reads that check run by name and refuses to merge without it. Changes it
   cannot prove offline - Rust, config, anything outside the TypeScript test
   runner - are failed on purpose and routed to you.
4. **A crash is not a failing test.** `vitest_proof.py` reads the Vitest JSON
   report rather than the exit code: an import error, a missing module, a config
   error or a run that collected zero tests proves nothing. The "before" run
   must contain an assertion failure, not merely a failing hook or runtime
   exception; the "after" run must pass all collected tests, without substituting
   skips. JSON/NUL paths and literal Git pathspecs preserve spaces and glob
   characters, and both sides of a rename are restored.
5. **"Still running" is not a verdict.** Quality and evidence results are read
   for `CI_SHA` as `passed | pending | failed | missing`. While a gate is pending
   the pull request is skipped and left unlabelled so the next gate completion
   can decide again; only a real negative result gets the `human-review` label.
   A missing evidence check is also left pending; a later completion can retry.
   `skipped` and `neutral` do not substitute for a successful gate.
6. **An approval belongs to a revision, not to a branch.** The
   `approved-by-owner` label survives a force-push, so a label is never accepted
   as approval. Only the owner's latest decisive review, approving `CI_SHA`,
   releases manual review. A later `CHANGES_REQUESTED` or dismissal revokes the
   earlier approval. Approval never releases a scope violation or an unread diff.
7. **Tasks have a lifecycle.** `todo -> in_progress -> done | blocked`, owned by
   `task_lifecycle.py`. A merged or closed pull request closes its task; a
   session that finished without changes closes it as `no_change` and the task is
   done, not retried. Active sessions are polled even when the selector reports
   `work_in_progress`. A completed session that produced a PR waits for its API
   outcome, not `no_change`. Repeated delivery of the same session/result does
   not spend attempts; failures get a new dispatch key on retry, and reaching
   `lifecycle.max_attempts` blocks the task. Confirmed active sessions and open
   PRs are not reclaimed as abandoned work. Only automation writes the queue.
8. **Nothing is closed by guesswork, and nothing waits for an event that never
   arrives.** A pull request must identify the current dispatch key or its
   recorded PR number; contradictory or stale markers are rejected. A task-id
   marker alone is accepted only for legacy first attempts with no dispatch key.
   There is no "only task in progress" fallback. A `GITHUB_TOKEN` merge starts
   no further workflow run, so completion/import runs directly after automerge,
   and `--action sweep` reconciles the full paginated PR history on each scheduled
   run. Each retry has a new dispatch key, so a retry cannot rediscover the
   previous finished session and stall.
9. **Research yields to concrete eligible work.** `research_cycle.py` creates one
   scoped investigation only when no eligible task or active session remains.
   Research is read-only and returns its report in the completed session, without
   a fictitious PR. `complete_jules_task.py` binds the exact session/dispatch,
   reads every activity page, selects the latest agent report and persists its
   findings with its outcome as one validated transaction. Repeated completion
   does not duplicate tasks. API failures leave the queue unchanged. A malformed
   report parks the completed attempt as `blocked / awaiting_report / report_invalid`;
   it never becomes `no_change` or starts another research session just to repair
   packaging. An unmarked or malformed newest message cannot resurrect an older
   valid report.
   Findings in older merged PRs still use the same bounded importer and exact
   attempt matching; malformed PR JSON prevents partial completion/import.
10. **Scope is checked, not trusted.** `check_change_scope.py` rejects anything
    outside `product.editable_globs` and anything in `product.excluded`.
11. **Sensitive paths need you.** Files in `product.manual_review_paths` (the
    client updater, its hooks, notices and their tests - ten paths) may be
    proposed by the loop but never merged unattended: the pull request is
    labelled `human-review` and stops there.
12. **Nothing releases.** `verify_policy.py` rejects release automation, protects
    all control-plane exclusions and the full updater surface, and requires the
    exact Linux/Windows and evidence check names. Autonomous Control CI executes
    regressions and parses workflows; source-text matches are not proof that a
    workflow enforces these contracts.
13. **New work uses accepted main.** `autonomous_sync.yml` prepares a real merge
    in a disposable detached worktree, preserving the lab queue's Git blob exactly.
    Only that queue may be resolved automatically; every other conflict stops the
    sync without changing the live branch. Windows and Linux verify the exact
    candidate SHA through the existing Quality Gate, without inherited secrets.
    Publication requires unchanged main/lab heads, both ancestors, identical queue
    blobs and a freshly enabled switch. Only then does an ordinary fast-forward
    push advance the lab. New tasks wait while main is missing from lab ancestry;
    existing bound sessions may still be polled and collected.

## Research cadence and saved results

`autonomous-project.json.research` defines six product areas (terminal, sessions,
workspace, settings, diagnostics and transcript) and four perspectives (behavior,
reliability, performance and UX). Green quality checks do not end the lab: a
measured limitation or a useful missing behavior can justify an implementation
task without inventing a failing linter. Only concrete observed findings become
work; unconfirmed ideas remain `next_hypotheses`.

The planner prefers unvisited area/perspective pairs, then the least recently
investigated pair. It fingerprints only tracked, permitted product blobs;
queue/control commits and untracked fixtures do not reset coverage. A changed
area can be investigated immediately after a successful report. Unchanged areas
and unsuccessful attempts wait 24 hours before a new investigation of that pair.
At most 24 new investigations are scheduled in a rolling 24-hour window; each
still has the existing bounded attempt budget. Concrete tasks bypass research
throttling. The planner reports the next eligible time instead of filling a quota.

Each investigation keeps `research` (area, perspective, fingerprint, cycle and
bounded previous reports) and `research_result` (summary, scenario/evidence/result
observations, next hypotheses, linked task IDs and completion time). The three
most recent reports from the same area are shared across perspectives; reports
from other areas are excluded. Rotation, cooldown and quota still use the
area/perspective pair, not the broader shared context. Findings
outside the execution boundary remain `deferred_findings` with their paths,
acceptance criteria and exclusion reason; they are visible but never dispatched.
`researched` means findings were recorded; `no_change` requires real observations
and an empty findings list. Neither is proof that a release is verified.

The seed queue is empty; the planner creates the first scoped investigation.
Preparing the lab preserves an existing queue and its history rather than
replacing them with the seed. Prior reports survive controller restarts.

## One-time owner setup

1. Install the **Jules GitHub app** on `Omnividente/omp-desktop` and allow it to
   open pull requests.
2. Add repository secrets: `JULES_API_KEY`, optionally `JULES_API_KEY_BACKUP`
   (used only when the primary key fails), and `PAT` - a token with the `repo`
   **and `workflow`** scopes. The loop switch needs it to write the
   `JULES_LOOP_ENABLED` Actions variable and to publish the entry-point
   workflows onto `autonomous/lab`; `GITHUB_TOKEN` cannot write
   `.github/workflows/**`. Trusted queue-persistence steps also use this token:
   their service commits have no product checks, so its owner must be allowed
   to bypass the lab ruleset. It is never used to merge product pull requests.
3. Merge the control plane into `main`. Until these workflow files are on the
   default branch, `workflow_run`-triggered automerge does not exist yet.
4. **Protect `autonomous/lab`** and require these check runs _by name_:
   `Checks (ubuntu-latest)`, `Checks (windows-latest)` - both produced by the
   `Quality Gate` workflow, and the required-checks list takes check-run names,
   not workflow names - plus `Autonomous Evidence Gate`. The same names are in
   `merge_gate.required_check_names`, which is what automerge reads. Allow only
   the owner's administrator role to bypass this lab ruleset for setup, queue
   commits and the trusted, exact-SHA gated main-sync publisher. Do not grant Jules
   a bypass. Ordinary product PRs still require their evidence and quality checks.
   The built-in GitHub Actions app cannot be added as a ruleset bypass actor;
   automerge keeps using its ordinary
   `GITHUB_TOKEN`, so GitHub enforces the product checks at merge time too.
5. Run **Autonomous Loop Switch** with `loop_enabled = true`. It first disables
   new dispatches, then creates/seeds the branch and publishes entry points,
   and only then enables the variable. A publication failure leaves the loop
   off and preserves the existing queue. With preparation disabled, every entry
   point must already match `main` or enabling fails.

Until step 5 no new workers or sync publications run. Explicit report recovery
may read and record a previously completed attempt while the loop is disabled;
it cannot dispatch a worker.

## Day-to-day

- **Autonomous Monitor** (every 3h, or on demand) reports real NextTask timestamps,
  branch/entry-point drift and read-only readiness. Due work without a tick for
  90 minutes, invalid parked reports and failed synchronization are visible as a
  failed monitor job, not a green claim of progress.
- **Autonomous Next Task** (30-minute fallback and event-driven wakeups) reconciles
  PR outcomes, plans research when concrete work runs out and starts or polls one
  worker. Stored attempts use GetSession directly; a missing session never causes
  a replacement CreateSession. Draft or blocking-labelled PRs do not occupy the
  active-work slot.
- **Autonomous Continue** runs after successful trusted controller workflows and
  main pushes. It takes two live snapshots, waits at most 90 seconds for an active
  worker poll, rechecks the switch and existing queued/running controller jobs,
  and dispatches at most one NextTask or Sync run. Explicit `workflow_dispatch`
  with `GITHUB_TOKEN` starts a fresh chain instead of depending solely on cron or
  exceeding GitHub's three-level `workflow_run` chain limit.
- **Autonomous Sync Main** runs on main pushes or explicit dispatch. Active
  workers and non-parked PRs defer it. After those finish, continuation requests
  the pending sync before any new research can use an obsolete product base.
- **Autonomous Replenish** (every 6h) remains an additional source of concrete
  ESLint/TypeScript diagnostic tasks, not the only reason the lab may do work.

### Recovering a completed research report

Open the NextTask run's `research-report-diagnostics-<run>-<attempt>` artifact.
It contains the exact task/session/dispatch binding, parser status and precise
rejection reason, plus a redacted report excerpt of at most 24,000 characters.
Redaction occurs before truncation; artifacts are retained for 14 days. Ordinary
health reports do not include worker prose or dispatch keys.

A valid observation report may omit the optional findings array when there are
no tasks. A present but malformed array is an error, never an empty list. To
re-read a repaired report from the same completed session, run **Autonomous Next
Task** on `main` with `task_id` and `recover_report = true`. The collector verifies
the stored binding and the live COMPLETED state; it never starts a worker or
charges an extra attempt. Repeated invalid recovery leaves queue bytes unchanged.
The equivalent CLI is `complete_jules_task.py --retry-report` with the existing
manifest/config/task/session arguments and optional `--diagnostics` path.

### Resolving a failed main synchronization

Inspect **Autonomous Sync Main** and its `autonomous-sync-preparation-<attempt>` /
`autonomous-sync-result-<attempt>` artifacts. The candidate branch is unique to
the run; cleanup only deletes that owned ref if its SHA still matches. A conflict,
failed gate or moved head leaves live lab unchanged. Disabling the loop during
verification also prevents publication.

Fix the reported conflict or failing check, then explicitly rerun the sync on
`main`. Optional `main_sha` and `lab_sha` pin the expected current heads. A failed
sync suppresses automatic retries for the same main revision, so a failing
candidate cannot create an endless build loop; a new main revision or a successful
manual sync releases that condition. No branch protection is weakened, no force
push is used, and no installer, version or release is produced.

### Accepting something the loop cannot merge alone

A draft PR or a PR with a configured blocking label (`human-review`, `hold`,
`do-not-merge`, `wip`) is parked as `blocked / awaiting_review / review_required`.
It remains available for later inspection while unrelated work continues. Its
eventual merge or close resolves the same attempt without charging another one.
Review it and merge it yourself when appropriate; do not remove the label or
weaken the evidence gate just to make automation accept it.

### Inspecting results and deciding on a release

Run **Autonomous Release Review** with its default `run_quality_gate = false`
for a lightweight on-demand report: investigations, observations, deferred
proposals, linked task/PR outcomes and the accumulated product diff. The queue is
read from `agent_tasks.json` in the exact reviewed Git commit, never from a moving
worktree. The report bounds and escapes worker prose; the full history remains
in that commit's queue. Inspection does not stop the lab or publish anything.

For release-readiness review, enable `run_quality_gate`. The existing Quality
Gate must verify exactly the pinned SHA. If the branch moves, a green result for
another commit is not accepted. The downloadable report says **NOT VERIFIED**
without that exact-SHA successful verification. Git/resolve failures produce a
failure artifact too; upload runs even when generation fails after checkout.

Releasing itself stays manual and unchanged: your existing release workflows,
your decision, your version bump.

## Stopping

Run **Autonomous Loop Switch** with `loop_enabled = false`. It stops all
dispatching and releases any task left in flight back into the queue.

**It does not cancel a worker session that is already running** - the worker API
documents no cancel operation. Stop such a session in the Jules UI if you need it
stopped immediately. Any pull request it still opens will sit unmerged while the
loop is off.

## Known limits

- **Rust and non-TypeScript changes cannot be proven offline.** The evidence gate
  fails them deliberately; they become owner decisions.
- **The updater is not untouchable, it is manual.** The loop may propose changes
  to `src/clientUpdater.ts`, `src/useClientUpdater.ts` and the related update
  notices, but they can only land with your review. (An earlier note claiming the
  updater is never touched was wrong.)
- **Very large pull requests.** The file list is paginated and cross-checked
  against the count GitHub reports, but a diff above
  `merge_gate.max_changed_files` (200) is handed to you rather than checked
  mechanically.
- **A merge event is not a guaranteed wakeup.** A merge performed with
  `GITHUB_TOKEN` starts no ordinary follow-up event, so automerge records completion
  directly. The trusted continuation workflow explicitly dispatches the next
  controller tick; the scheduled API sweep remains a fallback, not a timing SLA.
- **A fallback API key is only used when the primary key fails**, not for load
  balancing.
- **Findings are bounded** at 10 new tasks per report/PR. Missing fields or an
  overflow are not accepted as successful partial research. Prior-report context
  is capped at three reports and 24,000 JSON characters; full reports remain in
  queue history. Research quality still depends on the worker's actual evidence;
  orchestration cannot itself guarantee a useful product improvement.

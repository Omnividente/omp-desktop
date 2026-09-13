# Autonomous improvement loop - runbook

This is a **research and proposal lab, not an autonomous product acceptor**.
It investigates concrete scenarios, saves observations and opens improvement
PRs. A human or Main AI reviews and accepts or declines every proposal into
`autonomous/lab`. The lab never merges its own product PRs, writes `main`, bumps
versions or releases. Updating lab from accepted `main` is a separate checked
synchronization, not acceptance of a worker's proposal.

## Architecture

```text
main                  trusted workflows, scripts, policy and accepted product
  | checked main-to-lab synchronization
  v
autonomous/lab        product history; only manually accepted proposals
  | pinned product snapshot
  v
autonomous/attempt-*  immutable Jules starting ref for one saved attempt
  | Jules final report or PR -> controller -> human/Main decision
  v
autonomous/state      one JSON queue and its independent Git history
```

| Input        | Source                              | Purpose                                             |
| ------------ | ----------------------------------- | --------------------------------------------------- |
| `control/`   | `main`                              | Trusted scripts, policy and prompts                 |
| `lab/`       | `autonomous/lab`                    | Product tree, never the live queue                  |
| `queue.json` | `autonomous/state:agent_tasks.json` | Attempts, identities, reports and proposal outcomes |

`state_store.py` migrates the exact existing lab queue on its first successful
save. The original bytes remain the first state commit even if that operation
also changes a task. Subsequent writes use the previously read SHA as parent and
an explicit compare-and-swap lease. A stale writer or unreachable remote stops;
it never falls back to an old product queue. State writes do not move product
refs or invalidate strict up-to-date PR checks.

Queue writers share `autonomous-lab-queue`, `queue: max` and
`cancel-in-progress: false`; the Git lease also protects against independent
writers. The switch's stop flag is deliberately outside that lock. There is no
database or extra service. The JSON queue in the product remains a legacy seed.

After a saved terminal Jules outcome, the controller may delete that attempt's
starting ref only if its SHA is unchanged and no open PR uses it as base or head.
Deletion also carries an exact SHA lease; active, unknown or modified refs are
retained. A saved cleanup receipt prevents repeated checks of released refs.

The lab must carry the trusted event entry points `autonomous_evidence_gate.yml`,
`autonomous_next_task.yml` and `autonomous_control_ci.yml`. Loop Switch copies
these exact files from `main`; their scripts and policy still come from `main`.
This setup update needs a workflow-capable token and does not rewrite history.
PR checks also subscribe to base edits, so retargeting the exact Jules proposal
from its attempt ref to lab can run the evidence gate. Control CI tests trusted
`main` scripts for lab events and the proposed control-plane revision for a PR
into `main`.

## Invariants enforced by code

1. **No product automerge.** `proposal_review.py` emits `blocked`, `manual_review`
   or `ready_for_review`, always with `acceptance: manual`. Readiness is evidence
   for a human/Main decision, never a merge instruction.
2. **Identity comes from the worker API.** A saved dispatch key and exact Jules
   session must match its repository, starting branch and `outputs.pullRequest`.
   The receipt pins PR number, URL, repository and head ref. Owner-authored Jules
   PRs are supported; a matching author, copied title/body marker or foreign PR
   cannot bind or close a task, occupy the worker slot or inject backlog.
3. **Intent is durable before POST.** The controller persists the attempt before
   CreateSession. Restarts only reconcile that intent; an ambiguous timeout or
   server reply never causes a second POST for the same attempt. A definite
   non-transient rejection closes that attempt under the bounded retry policy.
   Failed state persistence stops further external actions. Before POST the
   controller rechecks the switch and pinned main/lab heads.
4. **Stopping retains uncertainty.** An old or unknown session is quarantined,
   not declared cancelled or recycled. Its key, session and attempt survive.
   Only a verified terminal outcome can release it safely. A completed session
   with a PR becomes `blocked / awaiting_review / review_required`; it frees the
   worker slot. Merge resolves the same task; close without merge permanently
   declines it. An active session cannot free its slot merely by opening a PR.
5. **Reports are imported transactionally.** Research collection reads all
   activity pages from the saved completed session, chooses the latest agent
   report, and binds its content hash and activity identity to the import. The
   complete validated queue update is saved together. Repeated completion does
   not duplicate tasks. API failure or an unmarked newest report cannot revive
   an older valid message. Malformed output becomes
   `blocked / awaiting_report / report_invalid`, not `no_change` or another
   worker; unrelated research can proceed. Editable PR bodies are never imported.
6. **One reviewed revision and one current base.** The review workflow pins
   `ci_sha`, the complete file list and current `lab_sha`, and verifies lab
   ancestry from the exact compare endpoint. Historical REST `pr.base.sha` is
   not the live lab tip. Head/base races before or after publishing withdraw the
   ready claim; the old artifact remains explicitly historical.
7. **No partial-diff approval.** `/pulls/{number}/files` is paginated and checked
   against the advertised count; the compare API's 300-file listing is not used
   as a complete diff. Both names of a rename are checked. Missing, duplicate,
   malformed or incomplete files and excluded paths cannot be approved away.
8. **Checks must be trusted and exact.** Required check names and GitHub Actions
   app identity must match the reviewed SHA. Missing, pending, skipped, neutral
   or foreign results cannot produce readiness. A green quality suite is not
   failing-first proof. Missing proof, test-only changes, unsupported changes,
   updater paths and large diffs retain an explicit owner-review requirement.
9. **A crash is not a failing test.** `vitest_proof.py` requires an executed
   assertion failure without the source fix, then passing collected tests with
   it. Import errors, failing hooks, runtime exceptions, zero tests and substituted
   skips are not proof. Tests-only changes cannot establish source-fix evidence.
   JSON/NUL paths, literal Git pathspecs and both sides of renames are preserved.
10. **Approval belongs to a SHA.** Only the owner's latest decisive review of the
    reviewed commit counts. A later changes-request or dismissal revokes it;
    labels such as `approved-by-owner` are hints, never authorization. Approval
    cannot waive identity, incomplete-diff or missing-check blockers.
11. **Research yields to concrete work.** The planner creates a scoped read-only
    investigation when there is no eligible concrete task or active worker.
    Observed findings become implementation tasks, not fictitious research PRs.
    Waiting human decisions do not stop discovery or main synchronization.
12. **New work uses accepted main.** Sync prepares a real merge in a disposable
    worktree, preserving lab's legacy queue blob. Non-queue conflicts stop it.
    Linux/Windows check the exact candidate without inherited secrets; unchanged
    live heads, both ancestors and an enabled switch are required before a
    fast-forward publication. Bound proposals are then refreshed through
    `update-branch` with `expected_head_sha`, never merged or force-pushed. Their
    new heads need new checks. Conflicts remain visible for manual resolution.

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

On a new lab the seed is empty; the planner creates the first investigation.
An existing lab queue is migrated byte-for-byte into `autonomous/state`, never
replaced with a fresh seed. Reports and pending proposals survive restarts.

## One-time owner setup

1. Install the Jules GitHub app for `Omnividente/omp-desktop` with PR access.
2. Configure `JULES_API_KEY`, optional `JULES_API_KEY_BACKUP`, and the existing
   controller `PAT` with repository and workflow access. The trusted controller
   uses it for the switch, state/attempt refs, entry-point publication and PR
   retarget/refresh. Product diagnostics and candidate checks run in separate
   jobs without that credential. The token is not used to accept product PRs.
3. Publish the reviewed control plane to `main` before using its workflows.
   Keep worker writes away from the trusted state branch and control paths.
4. Protect `autonomous/lab`: require `Checks (ubuntu-latest)`,
   `Checks (windows-latest)` and `Autonomous Evidence Gate`, not workflow names.
   Keep the existing narrow owner bypass for setup and the exact-SHA checked
   sync publisher; do not grant Jules a bypass. Unsupported proof remains a
   conscious owner decision, not a green assertion. Protect `autonomous/state`
   as controller-owned metadata rather than requiring product checks on it.
5. Run **Autonomous Loop Switch** with `loop_enabled = true`. It disables new
   dispatch first, prepares lab if absent, migrates state and preserves active
   identities in quarantine, verifies entry points, then enables the flag.
   A preparation failure leaves the flag off. With preparation disabled, the
   entry points must already match `main`.

No new worker or sync publication runs while disabled. Explicit report recovery
may read a previously completed session and save its result without dispatching.

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
  and dispatches at most one NextTask or Sync run. Dispatch uses the existing
  Loop Switch PAT, so the child's completion can trigger continuation again.
  `GITHUB_TOKEN` can start an explicit `workflow_dispatch`, but its downstream
  completion did not wake this loop during live verification. Ordinary reads
  still use the read-only `GITHUB_TOKEN`; cadence, queued-run checks and the live
  switch bound the repeated work instead of relying on GitHub's recursion guard.
- **Autonomous Sync Main** runs on main pushes or explicit dispatch. Legacy
  workers, including quarantined ones, are reconciled before moving their source.
  Immutable-attempt workers and pending human proposals do not block sync. It
  refreshes verified proposal branches and reports per-PR conflicts.
- **Autonomous Replenish** (every 6h) remains an additional source of concrete
  ESLint/TypeScript diagnostic tasks, not the only reason the lab may do work.

### Recovering a completed research report

Open the NextTask run's `laboratory-result-<run>-<attempt>` artifact. Its
`research-diagnostics.json` contains the exact task/session/dispatch binding,
parser status and rejection reason, plus a redacted report excerpt of at most
24,000 characters. `lab-result.json` records the last confirmed state revision.
Redaction occurs before truncation; artifacts are retained for 14 days. Ordinary
health reports do not include worker prose or dispatch keys.

A valid observation report may omit the optional findings array when there are
no tasks. A present but malformed array is an error, never an empty list. To
re-read a repaired report from the same completed session, run **Autonomous Next
Task** on `main` with `task_id` and `recover_report = true`. The collector verifies
the stored binding and the live COMPLETED state; it never starts a worker or
charges an extra attempt. Repeated invalid recovery leaves queue bytes unchanged.
For local administration use `lab_controller.py --recover-report --task-id ID`
with its repo/config/manifest/revision-file/out arguments, so the independent
state is saved with CAS. Calling the collector alone only modifies its input file.

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

### Accepting or declining a proposal

Every completed implementation PR waits as
`blocked / awaiting_review / review_required`, even with green checks. Read the
**Autonomous Proposal Review** comment or artifact for its pinned head/lab SHAs,
scope, exact checks, proof and remaining risks. `ready_for_review` still requires
your or Main AI's usefulness review and explicit acceptance. New commits or a
moved lab base require a fresh report. Labels do not approve a revision.

Merge the PR manually when appropriate; close it without merge to decline it
permanently. The controller reconciles that same attempt on a later tick. Do not
remove blocking labels or weaken checks merely to make the lab act: it has no
product acceptance path. Other work proceeds while the decision is pending.

### Inspecting results and deciding on a release

Run **Autonomous Release Review** with its default `run_quality_gate = false`
for a lightweight on-demand report: investigations, observations, deferred
proposals, linked task/PR outcomes and the accumulated product diff. Code and
state are pinned independently: `head_sha` identifies the reviewed product,
`state_sha` its queue snapshot. The report bounds and escapes worker prose; full
history remains in that state commit. Before migration it explicitly identifies
the legacy seed instead. Inspection does not stop the lab or publish anything.

For release-readiness review, enable `run_quality_gate`. The existing Quality
Gate must verify exactly the pinned SHA. If the branch moves, a green result for
another commit is not accepted. The downloadable report says **NOT VERIFIED**
without that exact-SHA successful verification. Git/resolve failures produce a
failure artifact too; upload runs even when generation fails after checkout.

Releasing itself stays manual and unchanged: your existing release workflows,
your decision, your version bump.

## Stopping

Run **Autonomous Loop Switch** with `loop_enabled = false`. The flag is cleared
before waiting for the queue lock. In-flight identities are then quarantined,
not returned to `todo`. A saved or ambiguous dispatch remains bound to that
same attempt across restart; the next enabled tick reconciles it first.

**This does not cancel a running Jules session.** Use the Jules UI if immediate
termination is required. There is an unavoidable race with an already accepted
external request: the controller can retain and reconcile it, not unsend it.
Re-enabling is not permission to duplicate uncertain work. Proposals are never
accepted by the controller, whether the loop is on or off.

## Known limits

- Rust and non-TypeScript work cannot establish the offline Vitest proof;
  evidence fails deliberately and the owner decides with the recorded risks.
- Updater changes and diffs above `merge_gate.max_changed_files` (200) require
  explicit owner review. A missing full diff remains blocked regardless.
- Scheduled reconciliation is a fallback, not a timing SLA; an absent callback
  cannot justify duplicate dispatch. Old paused, inaccessible or ambiguous
  workers remain visible in quarantine until terminal identity can be verified.
- The fallback Jules key is used after primary-key failure, not for load balancing.
- Findings are bounded at ten tasks per research report. Prior context is capped
  at three reports and 24,000 JSON characters; the full queue has Git history.
  Research quality still depends on actual worker evidence: orchestration alone
  cannot guarantee useful improvements.

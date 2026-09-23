# Autonomous improvement loop - runbook

This is a **research and proposal lab, not an autonomous product acceptor**.
It continuously investigates concrete scenarios and saves observations and proposed
improvements in a backlog. A human or Main AI decides which findings to reject,
implement externally or explicitly send to Jules for implementation. Only that
last path creates product PRs, each requiring a separate manual acceptance into
`autonomous/lab`. The lab never merges its own PRs, writes `main`, bumps versions
or releases. Checked main-to-lab synchronization remains separate from acceptance.

## Architecture

```text
main                  trusted workflows, scripts, policy and accepted product
  | checked main-to-lab synchronization
  v
autonomous/lab        product history; only manually accepted proposals
  | pinned product snapshot
  v
autonomous/attempt-*  immutable Jules starting ref for one saved attempt
  | research report -> proposed backlog -> human decision -> explicit implementation
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

Server protection is separate from CAS and from the controller code. Two active
rulesets match only `refs/heads/autonomous/state`: `autonomous-state-controller-writer`
restricts creation and updates to the current writer identity; the separate
`autonomous-state-history-integrity` forbids deletion and non-fast-forward updates
with **no bypass actors**. The writer's bypass in the first ruleset does not waive
the second. Do not require product checks or PR review for ordinary queue writes.
Rules distinguish GitHub actors, not individual tokens or programs using the same
actor. The owner and other credentials acting as that owner share the writer's
permission; the commit author alone does not identify the authenticated pusher.

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

1. **No product automerge.** `proposal_review.py` emits `blocked`, `manual_review`,
   `manual_bypass_required` or `ready_for_review`, always with `acceptance: manual`.
   Readiness informs a human/Main decision, never a merge instruction. A bypass
   requirement is not readiness and the report performs no server-side bypass.
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
4. **Stopping retains uncertainty.** Stale processing or an unknown session is
   quarantined, not declared cancelled or recycled. Its identity survives.
   Known feedback, plan-approval and paused states are not stale processing;
   explicit loop-disabled quarantine still applies. After resume, the stale
   timer starts at the later of the saved state transition and attempt start;
   identical polls do not reset it. Only a verified terminal outcome releases
   uncertain work safely. A completed implementation session with a PR becomes
   `blocked / awaiting_review / review_required`; it frees its implementation
   lane. Merge resolves the same task; close without merge permanently declines
   it. Merely opening a PR never makes a running session terminal. Pinned research
   waiting may free the research lane under invariant 11, without releasing its
   own unresolved attempt or scope.
   An owner may stage `reject` for a bound implementation without a known PR.
   It remains quarantined with a pending decision while the controller sends at
   most one stop instruction to the same session. Acknowledgement is not proof
   of termination: only an observed terminal worker, and any exact PR closed
   without merge, completes that rejection. No session history is deleted.
5. **Reports are imported transactionally.** Research collection reads all
   activity pages from the saved completed session, chooses the latest agent
   report, and binds its content hash and activity identity to the import. The
   complete validated queue update is saved together. Repeated completion does
   not duplicate tasks. API failure or an unmarked newest report cannot revive
   an older valid message. Malformed output becomes
   `blocked / awaiting_report / report_invalid`, not `no_change` or another
   worker; unrelated research can proceed. Editable PR bodies are never imported.
   A newly detected malformed report can receive one formatting-only message in
   that same session. `execution.report_repair` is persisted before POST; a lost
   acknowledgement or restart never grants another send. Pending repair polls
   every five minutes for at most six hours. Rejected, failed, conflicting,
   invalid or expired repair stays parked, without a new attempt.
   Normal polling accepts only a strictly newer activity; subsecond activity/request
   times are preserved. Explicit recovery can also reparse the exact immutable
   latest source after a parser fix. Rewritten activities are never accepted.
   Historical parked reports are touched only by explicit `recover_report` for
   their exact task. One additional format request requires owner authorization
   tied to the previous failed receipt; see report recovery below. While disabled
   recovery may read, but never send a repair request.
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
   failing-first proof. A failed TypeScript proof is a hard blocker even after
   owner approval. Unsupported, test-only or missing-test plans with a completed
   failed Evidence Gate yield `manual_bypass_required`, unless another blocker
   takes precedence. They need supported proof or a separate explicit owner
   server-side bypass decision. Updater paths and large diffs require owner review.
9. **A crash is not a failing test.** `vitest_proof.py` requires an executed
   assertion failure without the source fix, then passing collected tests with
   it. Import errors, failing hooks, runtime exceptions, zero tests and substituted
   skips are not proof. Tests-only changes cannot establish source-fix evidence.
   JSON/NUL paths, literal Git pathspecs and both sides of renames are preserved.
10. **Approval belongs to a SHA.** Only the owner's latest decisive review of the
    reviewed commit counts. A later changes-request or dismissal revokes it;
    labels such as `approved-by-owner` are hints, never authorization. Approval
    cannot waive identity, incomplete-diff or required-check failures.
11. **Research and implementation are independent.** Scheduled selection starts
    only read-only research, even when approved implementation tasks exist.
    Automatic imports and diagnostics enter `proposed`; historical nonresearch
    `todo` entries remain pending without rewriting their history. Implementation
    requires a recorded owner `approve` decision and an explicit `task_id`.
    One foreground research attempt and one implementation attempt may coexist.
    A pinned research session waiting for feedback, plan approval or resume may
    retain a sticky detachment marker and let another scope proceed. Its exact
    area/perspective remains occupied until it settles, even after code changes
    or late resume. Backlog size never blocks research.
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
reported measurable limitation or useful missing behavior can justify a proposal
for human consideration without inventing a failing linter. Unconfirmed directions
without an actionable reproduction remain hypotheses, not implementation work.

New imported findings require `evidence.reproduction`: a nonempty `steps` array
of nonblank strings plus nonblank `expected` and `actual` strings. The controller
whitelists these fields with `source`, `detail` and the bounded structural
`revisit` fields, and assigns `evidence.status = reported`; worker claims of
verification, review or approval confer no authority. Missing or malformed
reproductions are retained as `deferred_findings` with `unverified_finding`, not
queued as fixes or treated as a malformed whole report. Valid neighbors can still
be imported. Scope, immutable report provenance and deduplication remain required.

A reproduction plan is not proof that the claim is true. After an explicit human
decision and task selection, the implementation prompt requires the worker to run
the smallest real synthetic scenario on
its exact pinned base **before editing**. Without confirmation it must finish
`no_change`, explain the checks and limitations, and avoid an empty PR, adjacent
work or another verification session. This is a worker instruction, not a
controller-observed experiment; it can still spend a session on a false claim.
The PR report keeps `finding_evidence: reported` separate from
`proof_established`, which comes only from the trusted exact-SHA TypeScript gate.
Historical task evidence remains readable without migration or restarting an
active attempt; missing new fields never mean verified evidence.

The planner prefers unvisited area/perspective pairs, then the least recently
investigated pair. It fingerprints only tracked, permitted product blobs;
queue/control commits and untracked fixtures do not reset coverage. A changed
area can be investigated immediately after a successful report. Unchanged areas
and unsuccessful attempts wait 24 hours before a new investigation of that pair.
At most 24 new investigations are scheduled in a rolling 24-hour window; each
still has the existing bounded attempt budget. Explicitly selected approved
implementation bypasses research throttling. Unresolved area/perspective pairs
are never duplicated; if all scopes are unresolved, research waits rather than
starting unbounded replacement workers. The planner reports the next eligible
time instead of filling a quota.

Each investigation keeps `research` (area, perspective, fingerprint, cycle and
bounded previous reports) and `research_result` (summary, scenario/evidence/result
observations, next hypotheses, linked task IDs and completion time). The three
most recent reports from the same area are shared across perspectives; reports
from other areas are excluded. Rotation, cooldown and quota still use the
area/perspective pair, not the broader shared context. Findings
outside the execution boundary remain `deferred_findings` with their paths,
acceptance criteria and exclusion reason; they are visible but never dispatched.
The importer requires trusted product configuration even when invoked directly
with `--config`. Exact duplicates retain a canonical ID only when the complete
directed contract matches: paths, task type, title, detail, ordered reproduction
steps, expected/actual outcomes and acceptance. Similar wording is not proof;
it becomes `possible_duplicate` with a canonical review link and full evidence,
including incomplete reproduction, rather than another queued proposal or a
discarded claim. Independent contracts in one file remain separate. A task's
controller-owned `discovery_import` receipt is bound to the accepted report and
keeps replay stable after canonical work closes; it does not rewrite that work
or the immutable worker report. A new report may describe a genuine regression.
Worker-supplied IDs are suggestions, not authority over an existing task. If an
independent valid finding reuses an occupied ID, its new ID is deterministically
bound to the report origin and behavioral contract. The old task and decision
remain unchanged; the import receipt keeps replay idempotent.

Closed nonresearch tasks with a settled owner `reject` or `resolve` are also
checked at admission time. The boundary is the accepted source's
`activity_created_at`, not the import time: reports at or before the decision
are PRE, later reports are POST. Exact or possible overlaps that are all PRE
remain in `deferred_findings` as `historical_predecision_overlap`, not another
proposal. A strong POST match in a new versioned attempt must pass the structural
revisit gate below before becoming `proposed`; legacy attempts retain their old
admission rules. Neither path reopens or overwrites the old decision. A title-only
match is weak context and never suppresses an independent behavioral contract.
All historical links, match strengths and PRE/POST classifications are retained deterministically
in controller-owned `review_context` and validated against canonical decisions.
Worker-supplied review metadata is ignored. A missing/invalid trusted source time
refuses import without mutation. Open-task deduplication and closed tasks without
an owner decision retain their existing behavior. An already materialized import
receipt is replayed unchanged, even after a later owner decision; stale importers
must reload authoritative state after a CAS conflict before applying this policy.
Existing proposals are included as a labeled, bounded queue-context snapshot.
Shortened previous reports carry `context_excerpt` and original array counts;
their stored source reports remain unchanged.
`researched` means findings were recorded; `no_change` requires real observations
and an empty findings list. Neither is proof that a release is verified.

On a new lab the seed is empty; the planner creates the first investigation.
An existing lab queue is migrated byte-for-byte into `autonomous/state`, never
replaced with a fresh seed. Reports and pending proposals survive restarts.

### Versioned requests and historical POST admission

Every newly reserved research attempt stores `execution.research_request` before
CreateSession: `contract_version = post-revisit-v1`, the controller checkout SHA,
the exact credential-free request payload, its SHA-256 and the decision-context
snapshot/hash. The prompt includes that exact context. Reconciliation reads the
saved payload, not a new template or the now-mutated task; it keeps
`allow_create=False`. A reservation is intent, not proof of delivery or worker
understanding. A bound session confirms delivery, not the truth of its findings.
On a genuine retry, the prior request and attempt/session identity are retained
in `execution.research_request_history`; state writes cannot rewrite the same
attempt's payload or its history, even by recomputing hashes.

At dispatch, missing-context obligations take priority over other settled owner
notes and active proposal excerpts. Ties use prior full bound delivery count,
source timestamp, deferred ID and decision ID. Context has at most 10 entries
and 12,000 serialized JSON characters. Truncated notes are explicitly incomplete,
never counted as full delivery; reserved/unbound attempts do not count either.
Materialized obligations no longer take priority. Rotation does not bypass the
requirement that every mandatory note be delivered together for that candidate,
and deferred findings alone do not create another research session.

For all strong (exact/possible) POST matches with nonblank owner rationale:

1. Each canonical note must be fully delivered in this attempt's saved context,
   matching decision ID/action/time, full-note hash, exact text and `context_id`.
   Missing, stale or truncated context produces `historical_post_context_missing`.
2. `evidence.revisit` must declare `contract_version = post-revisit-v1`,
   `change_kind`, a nonblank `difference`, `evidence_mode`, unique zero-based
   integer `observation_refs` into this report, and `primary_decision_task_id`.
   Primary ordering is exact before possible, newest decision time, then task ID.
   `responses` must contain exactly one entry for each required rationale with
   `decision_task_id`, `decision_context_id` and nonblank
   `why_previous_reason_no_longer_explains`. Difference and response text are
   bounded at 4,000 characters. Missing/malformed links produce
   `historical_post_unexplained` without invalidating the observation report.
3. `change_kind` is `code_change`, `new_evidence`, `changed_conditions`,
   `different_contract` or `rationale_reassessment`. Evidence modes are
   `real_runtime`, `static_analysis`, `mock_or_model`, `hypothesis`, `unavailable`.
   The last two yield `historical_post_insufficient_evidence`; the others may
   pass structurally, but remain reported/unverified. There is no semantic judge:
   complete yet weak explanations can pass, and static/mocked observations are
   not native runtime proof. If no strong POST match has a recorded rationale,
   the historical fallback remains allowed with `rationale_status = unknown`.

Each of these three POST exclusions preserves a normalized complete `candidate`,
`review_context`, exact accepted `source` and deterministic `deferred_id` in both
the immutable import receipt and the accepted report, alongside the existing
flattened backlog fields. The ID excludes worker-suggested ID and import time.
In **Autonomous Backlog**, `materialize_deferred` requires the exact
`source_task_id`, `deferred_id`, configured owner and a nonblank note. It creates
only a `proposed` task, preserving reported evidence and source; it neither
approves nor dispatches Jules. Current product/reproduction/schema checks and
open exact/possible overlap still apply. An overlap fails with the canonical ID.
Repeating the same owner/note is a no-op; changing an existing authorization is
rejected. `materialized_from` and `deferred_materializations` retain both ends
of the audit link without modifying the original receipt or older decisions.

### Explicit research-contract cutover

Deploying the source and migrating live state are separate owner operations.
No reader silently migrates the queue. After the reviewed controller is on main:

1. Disable through **Autonomous Loop Switch** and let its writer job finish;
   this retains existing workers, it does not cancel external Jules sessions.
2. Review the current `autonomous/state` SHA. Run **Autonomous Research Contract
   Migration** on main with that exact `expected_state_sha` and a rationale.
   It requires the configured owner and disabled switch, holds the same
   `autonomous-lab-queue` lock as Next, Backlog, Switch and Replenish, rechecks the
   switch and publishes through CAS. Old lock holders drain before the cutover.
3. Inspect the migration receipt before enabling with Loop Switch. The top-level
   `version` becomes the string `post-revisit-v1` together with the policy marker.
   Old integer-only validators reject this queue, including old queued writers
   admitted after migration; CAS alone would not provide that version fence.
   New writers also reject a downgrade of the schema or request history.

Existing nonaccepted attempted research, including acknowledged but recoverable
incidents, receives `legacy-pr82` with `context_provenance = not_recorded`.
Accepted old reports/receipts, sealed disposition snapshots and unattempted tasks
remain unchanged. A later genuine attempt gets v1; recovery of the saved legacy
attempt never gains CreateSession authority. Do not roll back by deleting the
version marker or request metadata: use version-aware controller code.

For a local preview only, run `migrate_research_contract.py --manifest <copy>
--out <different-output> --config autonomous-project.json --actor <owner>
--note <rationale> --summary-out <receipt>`. It performs no API/Git effects unless
the separately guarded `--publish` workflow path is selected.

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
   failed required check, not a green assertion after PR approval.
   Protect exact `autonomous/state` with the two independent rulesets described
   above. Identify the real writer from push events/rule-suite evaluations, not
   the commit author. The current controller PAT acts as `Omnividente` (User
   `6513759`); only that actor bypasses creation/update restrictions. Leave the
   history-integrity ruleset without any bypass, including for the writer.
   Verify a normal controller CAS write after enabling protection; never test
   deletion or force-push by damaging the live queue.
5. Run **Autonomous Loop Switch** with `loop_enabled = true`. It disables new
   dispatch first, prepares lab if absent, migrates state and preserves active
   identities in quarantine, verifies entry points, then enables the flag.
   A preparation failure leaves the flag off. With preparation disabled, the
   entry points must already match `main`.

No new worker or sync publication runs while disabled. Explicit report recovery
may read a previously completed session and save its result without dispatching.

## Day-to-day

- **Autonomous Monitor** (every 3h, or on demand) reports branch/entry-point drift,
  last useful tick, last worker poll, deadline, overdue seconds and the active or
  pending continuation runs. `scheduler` is independent of proposal attention:
  an old conflict cannot hide a lost timer. Invalid reports, failed sync and due
  work without useful progress for 90 minutes still fail the monitor job.
  Lateness uses the actual cooldown, rolling daily-cap, polling or proposal-event
  deadline, not the age of the last useful tick. That boundary survives becoming
  due and observing an in-flight NextTask; failure backoff can still postpone it.
- **Autonomous Next Task** is called by continuation or explicit owner dispatch;
  it has no independent cron. It reconciles saved sessions and PR outcomes,
  collects reports and starts eligible research regardless of pending backlog or
  an implementation worker. An approved implementation is started only with its
  explicit `task_id`; it never becomes the default next task. A manual dispatch
  polls immediately. Stored attempts use GetSession directly; a missing session
  never causes a replacement CreateSession. Active lane and scope rules still apply.
  Automatic calls use `automatic=true` and no `task_id`; under the queue writer
  lock they fetch fresh heads and recheck readiness. Early/duplicate signals do
  not poll, spend an attempt or update progress clocks. A separate handoff job
  runs after that writer job, including failure, without retaining its lock.
- **Autonomous Continue** owns a bounded timer, not just a scheduled wakeup.
  It waits for `due_at`, checking the live switch at most every 30 seconds, then
  rereads state and heads before dispatching. It also waits while NextTask/Sync
  is busy rather than relying on a completion webhook. Each timer waits at most
  30 minutes; a longer cooldown is handed to another Continue before exit. The
  workflow has a 40-minute timeout to allow bounded reads and handoff overhead.
  Only one timer and one pending wakeup share the wakeup group; duplicate signals
  coalesce, never cancel the active owner and never hold `autonomous-lab-queue`.
  Ineligible feature/fork callbacks are isolated before concurrency admission.
  Normal continuation uses explicit `workflow_dispatch` via the existing Loop
  Switch PAT. Cron (every 5 minutes), trusted workflow completions and main
  pushes are recovery signals, not the normal timer. Continue does not trigger
  itself through `workflow_run`: cancellation of a replaced pending run must not
  recursively generate more callbacks.
  Polling uses 5 minutes for new/changed foreground research, 15 minutes after
  30 minutes without a state change, and 30 minutes for implementation, detached
  research or known waiting when no earlier research is due. Deadlines use
  durable useful progress and saved worker transitions, never green/skipped
  workflow completion. Failed ticks after the last useful successful tick back
  off for 5/15/30 minutes; empty successes do not reset that history.
  `health_snapshot.py` makes two bounded passes over all active Actions statuses
  and keeps their combined observations: a run starting between status queries
  must not make an occupied slot appear idle. It reads only the latest 100
  completed runs per workflow and fetches proposal details by saved provenance,
  including old `awaiting_review` PRs, rather than all PR history. If an active
  list contains fewer unique runs than its count, that status is read at most
  three times with 1/2-second delays; runs seen even on partial pages are kept.
  A persistently incomplete, malformed or capped result still fails closed.
  API reads are not a transaction; the writer lock and fresh state/CAS checks
  remain the effect gate.
- **Autonomous Sync Main** runs on main pushes or explicit dispatch. Legacy
  workers, including quarantined ones, are reconciled before moving their source.
  Immutable-attempt workers and pending human proposals do not block sync. It
  refreshes verified proposal branches and reports per-PR conflicts.
- **Autonomous Replenish** (every 6h) contributes ESLint/TypeScript diagnostic
  proposals to the backlog, not automatically approved implementation work.
- **Autonomous Backlog** is manual-only on `main`: use `list` to review the full
  uncapped JSON artifact and escaped summary; `approve`, `reject` or `resolve`
  require an exact proposal `task_id`, configured owner actor and nonblank note.
  `close_research_unaccepted` acknowledges one settled research incident under the
  same owner/task/note requirements; it does not accept its report or alter its
  machine execution outcome.

### Continuation evidence and recovery

NextTask, Sync and Loop Switch explicitly hand control to Continue after their
work. Inspect `continuation-<run>-<attempt>` or the corresponding `tick-handoff`,
`sync-handoff` or `switch-handoff` artifact for `outcome`, `reason` and `handoff`.
An HTTP acknowledgement alone leaves handoff pending. Confirmation requires the
matching trusted successor run, not the currently executing timer; an observed
failed/cancelled/skipped successor is not successful delivery. A reused pending
run must be an explicit dispatch, schedule or main push: a `workflow_run` listing
alone cannot prove that its upstream passes the continuation job's trust gate.
If the exact keyed Continue successor is observed `completed/cancelled`, a new
replacement can be confirmed within the same deadline, without another POST.
It must be absent from the pre-POST baseline and created no earlier than intent.
A pending `workflow_run` additionally needs the server-rendered
`Continue trusted callback <run_id>` marker, guarded by the workflow's upstream
trust predicate, same repository/main/Continue path and the exact controller
checkout SHA. Two fresh direct run-detail reads confirm the same pending
candidate; an admitted in-progress candidate confirms immediately. Changing
candidate or losing proof resets confirmation. No job-start proof is required
behind the held workflow lock. Wrong/older revision or unproved callback remains
unknown; original cancelled and replacement receipts are retained. Failures,
timeouts and NEXT/SYNC handoffs cannot use this replacement rule.

An ambiguous Next/Continue request is reconciled before at most one retry with
the same correlation key. Sync is pinned to main/lab and a pre-dispatch run-ID
baseline; its ambiguous POST is not retried. Snapshot reads use bounded retries;
unconfirmed handoffs exit with `pending`/`unknown`, not a green success claim.
API requests have a 20-second timeout. Snapshot and handoff deadlines are 120
seconds between bounded operations, not strict aggregate wall-clock limits.
If the owner and all pending successors are lost, recovery still needs a trusted
completion, watchdog or explicit owner wakeup; no external scheduler is added.

### Reviewing the accumulated backlog

Open **Autonomous Backlog** and choose `list` whenever convenient; dozens of
pending findings do not pause research. Every entry retains evidence, paths,
acceptance criteria and origin. The JSON artifact includes all entries, decisions
and deferred research hypotheses rather than truncating to active workers.

- `approve` records `proposal_decision = {action, actor, at, note}` and makes the
  proposal `todo`. It does **not** dispatch Jules. To delegate implementation,
  separately run **Autonomous Next Task** with that exact `task_id`.
- `reject` closes an unwanted inactive proposal. `resolve` closes work completed
  by you or Main outside Jules; explain the outcome in the note. Both preserve
  evidence, session, attempt and worker execution outcome.
- For a bound active or quarantined implementation with no known PR, `reject`
  records a pending decision and retains the same worker in quarantine. The
  backlog displays `rejecting`, not `rejected`. The controller persists a single
  `rejection_stop` intent before sending the stop instruction; lost acknowledgement
  never causes a resend. Only an observed `COMPLETED` or `FAILED` state can finish
  the decision. An unknown or still-running worker remains visibly pending.
- A PR appearing after rejection is not retargeted, closed or merged automatically.
  Inspect and close that exact PR without merging; the controller verifies both
  its provenance and terminal worker before completing the rejection. Other owner
  decisions cannot dismiss unresolved workers, reports or unsettled PRs.
- The same action/actor/note is idempotent and retains its first timestamp.
  Closed proposals cannot reopen. Earlier approval remains in the parent state
  revision when later rejected or resolved. All writes use the authoritative
  state CAS and owner allowlist; workflow `GITHUB_ACTOR` cannot be impersonated.
- `close_research_unaccepted` applies only to bound `blocked` research in
  `awaiting_report / report_invalid` or an exhausted failed attempt. The saved
  session must be terminal, without a PR, accepted result or unsettled format
  repair. Active/unknown workers, pending/conflicting repairs and unexhausted
  retries cannot be dismissed. The command writes only the state branch: no
  messages, worker dispatch, PR action, product ref change or reset of attempts.
  Its append-only `research_disposition.events` starts with `close_unaccepted`,
  owner, UTC timestamp, rationale and the exact attempt/incident snapshot. The
  snapshot preserves saved sources, errors, repair receipt and optional repair
  history even if a later successful recovery clears the execution diagnostics.
  Backlog exposes the audit trail; health lists an exactly matching old incident
  in `acknowledged` rather than repeating its alarm. A new error, source/identity
  mismatch, PR or active worker remains attention. Closure never means success.

Local administration uses `proposal_backlog.py --action ACTION --repo LAB
--config CONTROL/autonomous-project.json --manifest queue.json --revision-file
queue-revision.json --actor OWNER --task-id ID --note NOTE --json-out backlog.json
--summary-out summary.txt`. `list` needs no task or note and performs no state save.
The product seed is not an editable backlog; never change it to make a decision.

### A worker waiting for you

`worker_awaiting_feedback`, `worker_awaiting_approval` and `worker_paused` include
the task, safe session ID/link and observation timestamp in `waiting_workers`.
Normal waiting is informational, not a controller failure. Quarantine, unknown
identity, invalid reports and actual errors remain separate attention conditions.

Implementation requests set `requirePlanApproval=false` and `AUTO_CREATE_PR`.
For an owner-approved, bound implementation in `AWAITING_USER_FEEDBACK` with
no PR, the controller persists one `execution.feedback_nudge` intent before
instructing the **same** Jules session to decide routine in-scope details and
either propose a PR or finish `no_change` with honest limitations. An ambiguous
send or lost acknowledgement never triggers a blind resend. Quarantined work
keeps its exact attempt and continues to occupy its lane until a verified
terminal outcome or PR review. The instruction neither supplies missing facts
nor authorizes extra tasks, plan approval, merge or release. Rejected workers,
sessions already reporting a PR and disabled loops never receive it. The owner
decides whether to accept a proposed PR on GitHub, not in Jules. Unexpected
`AWAITING_PLAN_APPROVAL` and `PAUSED` remain observed, not auto-approved.

A waiting research session on its saved immutable attempt receives a sticky
`execution.research_detached = {at, reason}` marker. Another area/perspective may
proceed, while the old session stays unresolved, monitored and collectible. For
research-only `AWAITING_USER_FEEDBACK`, the controller sends at most one instruction
to finish existing observations and report limitations, not to implement or seek
more permission. A durable `feedback_nudge` intent is saved before the message;
lost acknowledgement or restart never blindly resends it. It is not a fabricated
answer, plan approval, cancellation or terminal outcome. Late resume keeps the
same identity and scope exclusion. Disabling the loop prevents new detach/nudge.

Queue `execution.observed_at` records session-state transitions, not every poll.
The optional `controller.last_poll_at` records a valid worker observation;
`last_tick_at` and `run_id` record a useful successful tick. These minimal clocks
are CAS-published in `autonomous/state` even when worker identity/state is
unchanged. A partial successful poll can advance `last_poll_at` without resetting
the failed-tick history. Skipped wakeups change neither clock. Session transition
timestamps, repeated identical errors and unchanged PR provenance remain stable.
The state store still checks CAS when bytes are unchanged, stopping a stale
writer before further API actions. Legacy queues without controller metadata
remain valid and use saved worker transitions until a real observation occurs.

### Recovering a completed research report

Open the NextTask run's `laboratory-result-<run>-<attempt>` artifact. Its
`research-diagnostics/*.json` files retain each task/attempt/source, including
reports that lack a valid source identity. Safe task hashes and content hashes
in filenames prevent a later worker or changed diagnostic from overwriting
another; identical documents reuse the same path. Each document contains the
session/dispatch binding, parser status and rejection reason plus a redacted
report excerpt of at most 24,000 characters. `lab-result.json` records the last
confirmed state revision. Redaction precedes truncation; all diagnostics are
uploaded even after failure and retained for 14 days. Health does not fetch
worker prose; acknowledged records expose their saved binding and diagnostics.

A valid observation report may omit the optional findings array when there are
no tasks. A present but malformed array is an error, never an empty list. To
re-read a report from the same session, run **Autonomous Next Task** on `main`
with `task_id` and `recover_report = true`. Every explicit recovery requires a
configured owner actor. It never starts a worker, charges an extra attempt, or
reconciles unrelated workers. A valid newer report can resolve
the attempt; after a parser fix the exact saved latest activity/hash can also be
reparsed. If a formatting repair left Jules `FAILED`, only that exact saved source
is eligible, not a new or older report. This does not turn the failed worker into
a successful implementation. Missing, ambiguous or rewritten output stays parked.
For local administration use `lab_controller.py --recover-report --task-id ID
--actor OWNER` with its repo/config/manifest/revision-file/out arguments, so the
independent state is saved with CAS. Actions passes the actual `github.actor`;
an explicit CLI actor must match `GITHUB_ACTOR` when that variable is present.

Explicit recovery does not advance `controller.last_poll_at` or `last_tick_at`,
or replace `controller.run_id`: these are global scheduler anchors. Its target's
observations and report are still saved, while unrelated workers retain their
polling deadlines, including workers awaiting completion of a rejection.

After `close_research_unaccepted`, ordinary recovery is strictly reparse-only.
The controller CAS-saves a `recover_authorized` event before reading Jules, then
selects the authorized saved activity and verifies its hash, timestamp, session
and dispatch binding, even if a newer activity exists. It cannot substitute a
different report or attempt. A valid result and `report_accepted` event are saved
together; parser, identity or transport failure leaves the report unaccepted and
records `recovery_failed`. The original closure remains in history. A crash after
authorization remains visible and needs explicit owner recovery to resume;
ordinary scheduler ticks do not resume a pending reparse. A benign parser failure
can remain acknowledged only while the original incident still matches exactly.
Missing/rewritten output, new transport errors, active workers and PR conflicts
are never hidden by the old acknowledgement. Recovery that loses a CAS race
cannot overwrite the fresh state or silently authorize further external effects.

When the latest output genuinely lacks the required research structure, do not
invent observations or reset the attempt. If the previous `report_repair` is
`invalid`, `rejected`, `expired` or `failed`, an owner may use `recover_report = true`
and `repair_after = <that receipt's exact at timestamp>`. On a completed session,
the controller first tries collection; if repair is still needed, it saves the
old receipt in `report_repair_history` and a new owner-authorized intent before
one format-only `sendMessage`. Replaying the same timestamp cannot send again,
even after a crash or lost acknowledgement. Pending/conflicting repairs cannot
be superseded this way; failed sessions must be inspected if exact-source reparse
cannot recover them. No automatic repair loop or replacement session is created.
After disposition, a new format request likewise requires explicit `repair_after`;
its durable recovery authorization records `mode = repair` and the exact receipt
timestamp. Only that pending authorized repair may resume normal report polling.
The CLI equivalent adds `--repair-after TIMESTAMP --actor OWNER`. Collector-only
`--retry-report --reparse-report --actor OWNER` performs no messaging and is useful
for an isolated replay of undisposed reports. Disposed reports require the
CAS-backed laboratory controller, not a collector-only file rewrite.

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

### Accepting or declining an implementation PR

Every completed implementation PR waits as
`blocked / awaiting_review / review_required`, even with green checks. Read the
**Autonomous Proposal Review** comment or artifact for its pinned head/lab SHAs,
scope, exact checks, proof and remaining risks. `ready_for_review` still requires
your or Main AI's usefulness review and explicit acceptance. New commits or a
moved lab base require a fresh report. Labels do not approve a revision.

`blocked` means resolve the listed blockers and rerun the report. In particular,
a failed supported TypeScript proof cannot be approved away. For
`manual_bypass_required`, the required Evidence check is still failed: provide
supported proof or make a separate, explicit owner server-side bypass decision
for that exact revision. Approval alone neither satisfies the check nor performs
the bypass. This report never accepts a proposal or changes repository rules.

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

An already waiting Continue observes the live switch without taking the writer
lock. Once it observes `false`, that invocation makes no new dispatch, even if
the flag is subsequently re-enabled. With a responsive runner/API, the 30-second
check interval and bounded switch read target detection within 60 seconds. This
does not undo a request already accepted by GitHub or Jules.

## Known limits

- Rust and non-TypeScript work cannot establish the offline Vitest proof;
  evidence fails deliberately. The report requires supported proof or an explicit
  owner server-side bypass, not ordinary approval or a ready claim.
- Updater changes and diffs above `merge_gate.max_changed_files` (200) require
  explicit owner review. A missing full diff remains blocked regardless.
- The timer occupies a runner while waiting, potentially most of each day.
  Measure runner-minutes during acceptance. Explicit handoffs remove cron from
  the healthy chain, not GitHub queueing delays or infrastructure outages. If all
  owners/signals are lost, recovery depends on the watchdog; there is no strict
  external SLA. Deployment acceptance requires six real Actions handoffs without
  cron and a 24-hour unassisted soak, with useful polling by `due_at + 5 minutes`
  when Actions/API are available. A local simulated Actions transport does not
  establish those live guarantees. Known waiting retains the attempt; stale
  unknown processing stays quarantined until terminal identity is verified.
- The fallback Jules key is used after primary-key failure, not for load balancing.
- Findings are bounded at ten tasks per research report. Prior context is capped
  at three reports and 24,000 JSON characters; the full queue has Git history.
  Research and implementation claims remain untrusted until checked. The
  reproduction shape and verification-first prompt preserve useful autonomy,
  but cannot guarantee truthful worker output, useful improvements or zero
  spending on false findings.

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

## Durable workflow execution rollout (separate, paused operation)

The durable journal separates dispatch delivery from permission to execute.
`dispatch_journal` is an append-only part of the authoritative state queue.
NEXT, CONTINUE and SYNC need a separately acknowledged first-CAS executor claim;
an owner, a new run attempt, a late delivery or a callback cannot renew that right.
The immutable correlation key, canonical inputs and frozen control checkout must
match the current frontier. Delivery acknowledgements, titles, result artifacts,
timestamps and journal commits do not prove a completed substantive effect.
Missing legacy journals fail closed: ordinary workflow runs never initialize one.
An internal sender intent can acquire its executor only from `workflow_dispatch`
carrying the original correlation key. Keyless cron, manual and callback ingress
cannot execute that intent, advance its frontier or replace its pending/unknown
delivery. The journal validator checks the dispatch binding as well.
The source run attempt stays in the trigger and exact receipt binding, but is not
a new logical callback identity: rerunning the source cannot reopen its frontier.

For an internal receiver, the checked event-main bootstrap authenticates the saved
controller SHA against the journal's original sender claim, workflow, key and exact
inputs, and verifies that it is an ancestor of checked main before checking it out.
External ingress cannot choose an older controller. NEXT/SYNC causal handoff remains
on checked event-main code: only after the real original run-bound outcome does it
reserve a **new** intent on that checked revision. Existing intents, executors and
saved requests are never repinned, reset or renewed to adopt an update.
Duplicate/coalescible ingress reports `coalesced / existing_receiver_active` only
after a fresh trusted Actions read binds a live original receiver/executor. A known
recorded outcome is observation-only; a spent executor without outcome or unresolved
delivery remains blocked. Reporting benign ingress grants no execution/send right.
NEXT/SYNC source jobs and their handoff use that same observation-only disposition
when execution was refused. They neither fabricate an effect receipt nor advance
the original frontier or reserve another send.
An authorized explicit report-recovery command is not a disposable wakeup signal:
benign busy ingress additionally CAS-saves it in `controller.owner_recovery_requests`.
That owner-command acknowledgement still grants no runtime right and never replaces
the current intent; the normal causal chain must admit its own future NEXT executor.

Exceptional **unclaimed delivery recovery** is a separate, explicitly authorized
owner operation, not a retry or a normal no-effect result. The main-only
`autonomous_recover_delivery.yml` workflow accepts exactly `expected_state_sha`
and `decision_id`, binds the original event inputs and configured owner to checked
event-main code, and calls `JournalStore.fence_unclaimed` once. It cannot dispatch,
switch the loop, change tasks, or impersonate NEXT/CONTINUE/SYNC admission.

1. Save the exact authoritative state SHA, target sender decision and immutable
   queue/journal baseline. The target must still be the current sent delivery with
   **no ExecutorClaim, phase, stage, effect or completion**. A spent executor is
   never recoverable through this command, even after its Actions run dies.
2. Deploy the separately reviewed compatible main revision first. Prove that its
   frozen-controller bootstrap rejects the revoked key and that an already
   checked-out old receiver fails closed on the new append-only event before any
   executor, worker or substantive effect. Delivery/run metadata alone is not
   this proof.
3. Dispatch `autonomous_recover_delivery.yml` on `main` with the two exact saved
   inputs. Its single state CAS appends `OwnerFence(owner_revoked_unclaimed)` and
   closes that logical frontier once; the owner event records its actual workflow,
   ref, actor, control revision and original state/decision pins. It does not invent
   an execution/effect/completion receipt or change the old GitHub run's status.
4. A moved head, executor race, unknown acknowledgement or invalid context returns
   a retained blocked result and stops. Do not retry with a new baseline or send a
   replacement merely because acknowledgement was lost. Reconcile the real state
   under owner review. An acknowledged fence replay is only `already_fenced`
   observation: no new event, claim, send or permission is issued.
5. Read back the acknowledged state head. Confirm the exact OwnerFence, one frontier
   increment, unchanged task/provider identities and substantive manifest, and the
   complete original journal prefix. Late keyed NEXT/CONTINUE/SYNC receivers and
   handoff report `stopped / delivery_owner_fenced` without Actions-run observation,
   body effects or another send. An unrelated unbound ingress remains blocked;
   it cannot infer another decision from the fence set.
   Readiness excludes a revoked delivery only when the validated OwnerFence and
   original workflow, frozen control SHA, exact correlation title, main branch,
   explicit repository identity and workflow_dispatch event match the observed run.
   Other active runs and incomplete/mismatched metadata remain blockers. The
   revoked run's queued status or later failure cannot add readiness/backoff; its
   raw GitHub status and journal history are not changed or declared completed.
6. Only after that irreversible denial and exact deployment proof may the owner
   start one distinct ordinary external checked Sync and continue the existing
   recovery plan. The fence itself neither calls `advance` on a runtime receipt
   nor schedules this continuation. Never reset the journal, repin the old intent,
   fabricate terminal Actions status, or blindly repeat its workflow dispatch.
   This source change does not hot-patch an already claimed receiver's frozen
   controller. If it still uses an older readiness observer, retain its claim and
   receipts: another fence or deleting a GitHub run requires separate explicit
   owner authorization. Do not infer permission to cancel/delete the original run
   or revoke a claimed executor from the one unclaimed-delivery recovery decision.

Exceptional **frozen CONTINUE cutover** requires a separate explicit owner decision.
It is not the unclaimed-delivery fence above and never revokes NEXT or SYNC.
`autonomous_cutover_continue.yml` runs the existing native owner entry with fixed
`--operation continue_cutover`; its only inputs are `expected_state_sha` and
`decision_id`. Default `--operation delivery` retains the original strictly
unclaimed OwnerFence operation and its distinct workflow/acknowledgement contract.

1. Deploy the separately checked compatible main revision first. Save the exact
   authoritative state head, selected current CONTINUE and complete body/journal
   baseline. A sent sender or a claimed CONTINUE executor is eligible only with
   **no effect, completion, phase claim or execution stage**. Waiting/Actions status
   alone grants no permission; prepared/finalizing SYNC and every NEXT stay protected.
2. Dispatch the owner workflow once on main with those exact pins. It binds the
   original event inputs, checked configuration, actual workflow/ref/control SHA,
   repository, owner and rerun actor, rechecks them before the native operation and
   uses one CAS attempt. A head/claim/effect race fails closed without rebasing the
   owner request. It appends only `OwnerContinueCutover(owner_cutover_continue)` and
   increments the logical frontier once; it preserves the entire substantive body,
   journal prefix and original send/executor receipts. It neither impersonates
   execution completion nor records a runtime effect, calls `advance`, dispatches,
   edits tasks, switches the loop or changes any GitHub run's status.
3. Read back the acknowledged event and verify that late keyed bootstrap rejects
   the cut-over decision before frozen checkout. Already captured sender/executor
   capabilities cannot consume, observe or record an effect after the closure.
   Old frozen controllers fail closed on the new authority event. Disposable native
   proof exercises an actual published controller that acquired its executor before
   cutover and cannot record its previously valid continuation effect afterward.
4. A lost acknowledgement/conflict or failed result retention remains blocked;
   reconcile the real state instead of repeating the POST or changing the expected
   SHA. Replay with the original owner run/context and inputs (rerun attempt may
   change) only observes `already_cut_over`: no new event, claim or send permission.
5. The owner receipt is **not** timer/sender authority. `reserve_send` and runtime
   `advance` cannot use it. The next decision must be one distinct ordinary keyless
   external checked SYNC; its existing `external_ingress` basis explicitly retains
   `state_sha` and `owner_cutover=<receipt_id>`. Other automatic ingress cannot seize
   this frontier. Only the SYNC's own legitimate outcome can feed a later handoff.
6. Readiness removes only the validated closed CONTINUE delivery with exact workflow,
   frozen pin, correlation title and explicit repository identity. For a claimed
   CONTINUE, including an external one without a keyed title, it requires the exact
   original executor run ID, attempt and event in that repository; the durable claim
   binds its frozen controller. Actions `head_sha` is the event-main revision, which
   can differ from that frozen checkout. Main-branch/trust filtering remains unchanged.
   Missing/mismatched identity and unrelated runs remain visible;
   the raw run and all history are retained, and no terminal status is fabricated.
   Preserve the original fenced NEXT run and all worker identities. This cutover is
   not permission to delete a run, reset the journal or repin an old intent.

Exceptional **observed original NEXT completion** also requires a distinct explicit
owner decision after separately checked source deployment. It is neither revocation
nor a NEXT rerun. `autonomous_complete_next.yml` accepts only `expected_state_sha`
and `decision_id` and invokes the native owner entry with fixed
`--operation next_completion`.

1. Select the original consumed automatic sender NEXT with no effect, completion,
   execution stage or phase claim. Save the exact current state and complete
   task/controller body and journal prefix. Waiting status, a run title, POST ACK
   or a report supplied by the operator is not completion evidence.
2. The controller authenticates the original completed failed run and attempt 1,
   main branch, repository/head-repository IDs, actor/triggering actor, exact frozen
   head and correlation key, stable workflow ID/path, successful authenticated
   checkout/policy steps, failed native CLI step and successful artifact upload.
   REST `run.name` and `job.workflow_name` are dynamic run names, not static workflow
   identity. This narrow operation rejects mixed event-head/frozen-pin sources.
3. Authenticated GETs must find one nonexpired exact-name original artifact and
   verify the downloaded ZIP SHA256 against mandatory metadata. The bounded archive
   contains only a regular `lab-result.json`; its native result must bind this
   decision and actual state SHA, `automatic=true`, `skipped=true`, `action=none`,
   `reason=sync_running`, with no effect receipt, observations, proposals, waiting
   workers or research change. Archives and raw reports remain in memory only.
4. Actual Git checkpoints before the executor claim, named by the original report,
   and at the fresh CAS pin must have identical full task/controller bodies. The
   report checkpoint must retain the exact original consumed executor. One owner-
   bound CAS appends only `OwnerNextCompletion(next_no_effect_observed)` and closes
   that frontier once. It preserves all prior journal events and send/executor
   rights, without dispatch, provider POST, task mutation, repin, revocation,
   useful clock change or fabricated successful GitHub status.
5. Conflicts, unknown acknowledgement or result-retention failure stay blocked;
   reconcile the actual state, never substitute a fresh pin or blindly resend.
   Only the same original owner event and inputs (rerun attempt may differ) can
   observe `already_completed`, with no write or repeated artifact requests.
6. After read-back of the receipt, preserved body/history and denied old execution,
   use the separately authorized ordinary new-control sender and checked Sync.
   The owner operation itself does not perform handoff or renew execution. Existing
   report-invalid attention remains visible until original-source recovery and
   strict intake actually succeed; this no-op is not useful scheduler progress.

Exceptional **observed failed report-recovery checkpoint** requires its own explicit
owner decision and separately checked source deployment. The paused automatic NEXT
operation above cannot be reused: this is a failed manual report command with a
durable owner execution acknowledgement, not an unchanged `sync_running` no-op.
`autonomous_complete_report_recovery.yml` accepts only `expected_state_sha` and
`decision_id`, invoking `recover_delivery.py --operation report_checkpoint`.

1. Select the original unfinished sender NEXT with `recover_report=true` and its
   exact nonempty failed `repair_after`. Its original task/attempt and queued owner
   command must be bound and authorized; effects, stages, phase claims and prior
   completion are forbidden. Save the complete native/body/history baseline.
2. Authenticate the original attempt-1 failed run and native artifact using the
   same strict workflow/run/pin/actor/key/jobs/digest checks as the pause reader.
   The exception envelope has exactly `action=stopped`, `merge_mode=manual`,
   `reason=state_write_failed`, the fixed state-save attention and actual state SHA.
   It does not serialize `decision_id`; original run/artifact/key identity supplies
   that binding. Bounded regular native `research-diagnostics` ZIP members may be
   present, but their contents are never parsed as evidence or retained in proof.
3. Prove actual Git lineage and full before/native/current bodies. The only
   substantive delta may be addition of the exact original `record.execution` to
   one preexisting command. Every task, report receipt, request, identity and clock
   must be unchanged; the target must still have the exact original invalid receipt.
   This excludes the durable pending checkpoint required before a provider POST.
   Unknown outcomes or any later task/receipt mutation cannot use this operation.
4. One owner-bound, non-retrying CAS appends
   `OwnerReportRecoveryCheckpointCompletion(report_recovery_checkpoint_observed)`
   with `status=failed_before_provider_post`. It preserves the native failed
   envelope, all original claims/history and useful clocks, and closes only that
   frontier. It issues no runtime capability, performs no send/handoff and does
   not manufacture successful worker or GitHub status. Same-owner original-input
   replay may only observe `already_completed`; changed authorization fails closed.
5. Read back the exact receipt/body/history and denied old execution. Old frozen
   readers fail closed on this new event. Use one separately authorized ordinary
   checked-main Sync/adoption to start compatible code, never rerun or repin the
   old executor. Invalid-report attention remains truthful.
6. Compatible planning recognizes only this exact original failure receipt as
   permission to select the same previously unposted command again, subject to
   normal pair occupancy. Only a new ordinary causally selected admitted NEXT may
   append one `resume_execution`. Original `execution` stays immutable; both runtime
   identities remain append-only. This uses the unchanged original failed-receipt
   permission, not a new owner authorization or automatic POST retry. A consumed,
   pending, rejected, unknown or lost-ack resume cannot renew itself.



First introduction of the journal requires a separately authorized paused rollout;
these initialization notes are not permission to run commands against production:

1. Disable the loop and stop/drain outstanding NEXT, CONTINUE and SYNC runners.
   Keep uncertain provider sessions, saved recovery receipts and proposals intact;
   do not cancel/recreate workers or recycle an old execution claim.
2. Save the exact authoritative state revision and queue bytes, and identify the
   accepted trusted control revision and current main/lab pins. Review the local
   candidate and its synthetic failure/interleaving proof before deployment.
3. Publish the reviewed scripts and workflow definitions only under a separate
   source-publication authorization. Keep automation disabled while installing
   the same controller entrypoints. Old and new executors must not overlap.
4. Under separate initialization authorization, invoke `JournalStore.initialize`
   with the exact saved `expected_sha`, frozen `control_sha` and reviewed `basis`.
   Initialization uses the normal state CAS, preserves all task/provider identities
   and must not silently reset an existing journal. A changed head requires a fresh
   operator review, not an automatic retry using another baseline.
5. Read back the acknowledged state head and materialized journal, confirm the
   expected Init/frontier and unchanged substantive queue, then enable the switch
   under the existing owner authorization. Exercise one actual admitted workflow
   and inspect its durable receipt before allowing the ordinary scheduled cadence.

NEXT records a saved substantive controller change or a completed live poll of
bound workers, checked against the original executor and authoritative before/after
revisions. An unchanged poll needs the actual bound session observations and saved
poll checkpoint; timestamp-only writes do not grant progress. Manual implementation
approval and exact report/feedback recovery authorization remain independent.
A normal unchanged NEXT result, such as an explicitly selected already-finished
task, records `ExecutionCompletion(next_no_effect)` instead of leaving an unfinished
executor claim. Automatic `sync_running` and `sync_required` pauses use this same
completion contract even with descriptive parked-report attention. The exact
attention remains in the report and warning exit status; it is never hidden or
reclassified as successful intake. Worker observations, proposals, waiting workers
and research changes cannot be completed this way. Before/after state revisions
and current substantive digest must match the original executor baseline. This
closes one frontier without a useful-effect receipt or useful clock update; unknown
outcomes stay spent and blocked. The original receipt permits only the ordinary
causal handoff; replay never starts another worker or renews a claim.

SYNC preparation saves a durable `sync_prepared` checkpoint after publishing and
checking its isolated candidate ref. This checkpoint is not progress. A separate
first-CAS `sync_finalize` phase belongs to the same original run, attempt and
control revision; even a rerun of only the final job cannot execute it again.
Publication receipts require successful exact-candidate gates, verified unchanged
heads/ancestry/legacy queue blob and read-back of the actual published lab SHA.
Known no-effect preparation (up-to-date, busy, conflict or disabled) records a
separate `ExecutionCompletion(sync_no_effect)`. Exact live pins, no published owned
candidate, no prepared/finalize stage and the unchanged substantive baseline are
verified before CAS closes that logical frontier. An up-to-date completion also
verifies actual main ancestry and the immutable queue blob. It issues no publication
or useful-effect receipt, updates no useful tick/poll and never restores a claim.
Replay is observation only; the next legitimate decision can be admitted normally.
Proposal refresh and owned-ref cleanup run inside the admitted finalization body.

Handoff reads the original run-bound durable receipt from the state journal;
artifacts carry diagnostic references only, never transferable execution rights.
Every sender basis identifies the current predecessor's exact durable receipt.
An old handoff after newer progress only reports that its source was superseded;
it cannot dispatch from a stale receipt under a newer predecessor. The reservation
CAS rechecks that binding, including races after an idempotent Advance. Callbacks
cannot manufacture another frontier from a completed title or artifact URL. If a
runner dies after its executor/phase claim without a known terminal outcome, keep
the claim spent and inspect its actual state/ref effects manually.
Rollback means pausing and deploying a separately reviewed compatible controller;
never drop the journal, force-rewrite state history or run a legacy dispatcher
against an initialized live journal to regain execution permission.

Local control-plane verification uses `dispatch_observer_test.py --report <path>`:
the real `Runtime.observe`, its snapshot child, shared health policy, admission,
NEXT controller and receipts execute against disposable Git and loopback HTTP.
The no-effect SYNC chain includes an actual worker GET and saved controller
checkpoint. Parent elapsed time and diagnostic `--now` are synthetic; this is
not hosted Actions concurrency, platform-gate or production-rollout evidence.
The older `dispatch_integration_test.py` matrix injects health and remains a
separate safety regression, not proof of the production observer path.

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
   Authentication failover applies to reads only; mutation calls use one selected
   key so a 401/403 cannot replay CreateSession or sendMessage with a backup key.
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
   Initial requests, research completion nudges and format-only repair use the
   same `research_completion_prompt` contract with exact task/dispatch identities.
   Its executable local recipe uses standard JSON serialization, parses it back
   and invokes the existing research/proposal validators before emitting one
   complete literal envelope. Backticks are not Markdown-escaped. The worker must
   copy the entire stdout into its next final API-visible agent message, not an
   acknowledgement, a file reference or a promise to package later. Recipe source
   assembles dispatch markers at runtime so its text cannot contradict the real
   request header. Local validation is packaging proof, not report acceptance.
   Formatting-only local commands are allowed, but new research, network access,
   implementation and invented evidence are not.
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

The root `AGENTS.md` supplies stable project boundaries and links to the rendered
task contracts; it does not replace a saved immutable request or owner decision.
Publish it through a reviewed main change and checked main-to-lab synchronization
before expecting future Jules attempts to see it. Existing attempts retain their
original base and request.

Prepare the Jules repository environment with Node.js 22, Rust stable plus
`rustfmt`/`clippy`, `npm ci`, and the Linux Tauri packages used by `pr.yml`. Run
and snapshot only after the setup checks succeed; refresh the snapshot after
toolchain or lockfile changes. For rustup's Linux cross-device rename error,
`RUSTUP_PERMIT_COPY_RENAME=1` on the install command enables its documented
copy fallback, at the cost of some installation transaction protection. Do not
change project dependencies to accommodate the VM. A snapshot serves future
repository tasks, not a repair or replacement of already running sessions.
It does not establish Windows/WebView2 behavior or replace the two-platform gate.

The global Jules setting **Only respond to comments that mention @jules** makes
PR feedback explicit. Automated review reports do not carry that invocation.
This setting is not a documented off switch for CI Fixer or the controller's
direct `sendMessage` API; do not assume it prevents either channel.

## Day-to-day

- **Autonomous Monitor** (every 3h, or on demand) reports branch/entry-point drift,
  last useful tick, last worker poll, deadline, overdue seconds and the active or
  pending continuation runs. `scheduler` is independent of proposal attention:
  an old conflict cannot hide a lost timer. Invalid reports, failed sync and due
  work without useful progress for 90 minutes still fail the monitor job.
  Lateness uses the actual cooldown, rolling daily-cap, polling or proposal-event
  deadline, not the age of the last useful tick. That boundary survives becoming
  due and observing an in-flight NextTask; failure backoff can still postpone it.
  The shared read-only `dispatch_journal` view includes the active decision, pinned
  inputs/control/run/attempt, execution phase, consumed claims and missing receipts.
  Ordinary short pending uses the existing five-minute polling grace. Lost ACK
  without a known live run is `journal_delivery_unknown`; claim-only past grace is
  `journal_send_spent_without_receipt`; acknowledged delivery without an executor
  is `journal_executor_overdue`. Failed/cancelled runs and spent executors lacking
  receipts remain separate attention. Disabled keeps these and all task/report/PR
  diagnostics. The view does not mutate queue, journal, cadence or useful clocks.
  Inspection and Monitor CLI share one workflow collector. If an unfinished
  pinned executor is absent from its workflow's bounded snapshot, they read
  `actions/runs/<id>` directly. Missing/unavailable exact reads leave that run
  unknown; Monitor reports missing receipt after grace, without restoring saved
  `queued`/`in_progress` observations as current liveness. Malformed/wrong identity
  fails closed. The diagnostic CLI emits JSON; Monitor's job alarm checks
  `health` and `attention`, not just the CLI exit code.
  Only a descriptor matching the exact unfinished consumed claim (decision,
  claim, full trigger, control revision and actual current run) bypasses its own
  journal action suppression. A fresh own SendClaim qualifies only before any
  delivery, executor, effect or completion exists. The snapshot child checks
  that descriptor against the actual workflow context. Plain `current_run_id`
  grants no exception; other occupied NEXT runs and subject readiness still
  block. These descriptors are read-only metadata, never execution/send rights.
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
  After its own durable SendClaim it rereads health with the consumed claim's
  exact descriptor, rechecks main/lab refs and normalized target inputs plus the
  live switch/context, and permits at most one POST. A failed check leaves the
  claim spent; a changed owner/run attempt, replay or lost ACK cannot renew it.
  Keyed `workflow_dispatch` successors use `autonomous-lab-wakeup-chain`; keyless
  cron/push/manual/trusted callbacks use `autonomous-lab-wakeup-ingress`. Each lane
  has at most one running and one pending workflow, with `cancel-in-progress:false`.
  Keyless bursts coalesce only ingress: they cannot evict the required chain slot.
  Same-key duplicates can replace the pending run, but journal CAS admits exactly
  one executor for that decision. SYNC uses the corresponding separate sync lanes.
  No per-key groups or expanded pending queue are needed. An operator dispatching
  a different nonempty key still uses chain; Actions expressions cannot validate
  journal keys. Ineligible feature/fork callbacks remain isolated before admission.
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

NextTask and Sync hand control to Continue after their work; Loop Switch only changes
the enabled state and fences writers. Inspect `continuation-<run>-<attempt>`,
`tick-handoff` or `sync-handoff` for `outcome`, `reason` and the original durable key.
An HTTP acknowledgement alone leaves handoff pending. Run titles and trusted run
observations are delivery diagnostics, never executor claims or completed effects.
Continue-to-Continue exits after its one POST without waiting under chain concurrency;
the next keyed executor must then actually complete its own admitted stage.

Pending/unknown/lost ACK, rerun, a later owner and cancellation do not grant another
POST or keyless replacement. No ambiguous request is retried. New send permission
requires a new first acknowledged CAS for a decision bound to the current causal
receipt. Unresolved delivery/execution remains visible in Monitor and requires
review of actual effects, not journal deletion or fabricated progress. Snapshot
reads retain their bounded retry policy; this is not a dispatch retry. API requests
have a 20-second timeout; bounded handoff reads have a 120-second confirmation window.


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
Brief waiting is informational. After 90 minutes without a session-state
transition, `worker_wait_prolonged` becomes attention even if a nudge was sent.
This does not invent a terminal result or stop unrelated detached research.
Quarantine, unknown identity, invalid reports and actual errors remain separate.
An unknown transition/start time is still reported as waiting, but cannot establish
the age needed for a prolonged-wait claim.

Implementation requests set `requirePlanApproval=false` and `AUTO_CREATE_PR`.
For an owner-approved, bound implementation in `AWAITING_USER_FEEDBACK` with
no PR, the controller persists `execution.feedback_nudge` before instructing
the **same** Jules session to decide routine in-scope details and either propose
a PR or finish `no_change` with honest limitations. Each new instruction requires
the newest authenticated `agentMessaged` activity from the bound session. A
strictly newer activity after a `sent` receipt may receive one further instruction;
the old receipt is retained in `feedback_nudge_history`. The same activity never
receives an automatic resend. Pending, unknown or rejected receipts block further
sends, even for a new question. A source/hash conflict or incomplete activity
history requires inspection. Quarantined work
keeps its exact attempt and continues to occupy its lane until a verified
terminal outcome or PR review. The instruction neither supplies missing facts
nor authorizes extra tasks, plan approval, merge or release. Rejected workers,
sessions already reporting a PR and disabled loops never receive it. The owner
decides whether to accept a proposed PR on GitHub, not in Jules. Unexpected
`AWAITING_PLAN_APPROVAL` and `PAUSED` remain observed, not auto-approved.

A waiting research session on its saved immutable attempt receives a sticky
`execution.research_detached = {at, reason}` marker. Another area/perspective may
proceed, while the old session stays unresolved, monitored and collectible. For
research-only `AWAITING_USER_FEEDBACK`, each authorized activity receives an
instruction to finish existing observations and report limitations, not to
implement or seek more permission. A durable source-bound intent is saved before
the message. Legacy `sent` receipts without sources permit only a verified newer
activity after the recorded send time; ambiguous legacy receipts remain blocked.
`sent` is transport acceptance, not evidence of resume. Late resume keeps the
same identity and scope exclusion. Disabling the loop prevents new detach/nudge.
Existing retry paths archive old attempt identities and complete receipt chains
in `feedback_nudge_attempt_history`; they do not rebind old feedback to a new session.
Receipt-shape validation survives a later legitimate owner `resolve` decision;
it is historical evidence, not authorization for a new instruction.

For an inspected session still waiting after a settled `sent` instruction, an
owner may explicitly choose **Autonomous Next Task** with `task_id`,
`recover_feedback = true` and `feedback_after = <exact feedback_nudge.at>`.
The live session must still be bound, `AWAITING_USER_FEEDBACK` and without a PR;
implementation additionally retains its recorded owner approval. This command
can use the same verified older activity only under that explicit authorization.
It CAS-saves `{actor, after}` with the new receipt before one send. The exact prior
timestamp is consumed once; replay, lost acknowledgement or restart cannot send
again. Pending, unknown and rejected receipts cannot be superseded this way.
Only the selected worker is inspected; other attempts and global scheduler clocks
remain unchanged. It never creates a session, approves a plan, cancels work or
fabricates completion. The CLI adds `--recover-feedback --feedback-after TIMESTAMP
--task-id ID --actor OWNER`. Observe an actual subsequent session transition and
accepted report/PR; do not treat the send receipt as recovery proof.

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

If another receiver already owns the journal, a trusted-main owner dispatch retains
this distinct command instead of losing its inputs through generic coalescing.
The result is `queued / owner_report_recovery_queued`, with
`owner_recovery.request_id` and `state = pending`. Append-only
`controller.owner_recovery_requests` preserves the original owner run/attempt/actor,
normalized manual inputs, task/session/dispatch/attempt/base binding and request time.
This is a saved command, not an executor claim, effect receipt, accepted report or
evidence that Jules resumed. Blocked or uncertain ingress cannot grant that right.

After existing main/SYNC compatibility checks, the genuinely owned CONTINUE gives
the oldest eligible pending command priority over ordinary polling, detachment and
scheduling. A new format-only send with `repair_after` is deferred while another
unresolved attempt occupies its exact research area/perspective pair. The command
and its original one-use permission remain unchanged; polling must settle the
earlier attempt before that repair becomes eligible. Independent pairs remain
eligible, and collector-only recovery without `repair_after` does not reserve a
pair. This does not relax the validator's single-unresolved-pair invariant.
It dispatches NEXT with the original `task_id`, `recover_report` and `repair_after`,
never converting it into automatic research. Only the actual consumed NEXT execution
capability can CAS-bind `execution` to that exact command before its normal recovery
body runs. Revoked authorization, foreign repository, rebound attempt or malformed
inputs fail closed; monitor attention for the unaccepted report remains truthful.

Replaying an exact failed receipt deduplicates the saved command across later owner
runs. Once claimed, ingress reports `observed / owner_report_recovery_already_claimed`
and `state = claimed`; it neither renews the executor nor repeats provider messaging.
Collector-only commands without `repair_after` deduplicate reruns by original run ID.
Never delete or rewrite command history, including after a later task retry. Deploy
and verify the compatible active controller before issuing recovery commands. Submit
multiple distinct owner workflow commands one at a time and confirm their durable
queue/claim result: GitHub's keyless ingress concurrency can replace a pending run
before its body ever saves the command.

Explicit recovery does not advance `controller.last_poll_at` or `last_tick_at`,
or replace `controller.run_id`: these are global scheduler anchors. Its target's
observations and report are still saved, while unrelated workers retain their
polling deadlines, including workers awaiting completion of a rejection.
Targeted observations are not serialized as global scheduler poll evidence. A
successful recovery's causal checkpoint must come from real saved substantive
task/receipt/command changes; it cannot manufacture `last_poll_at` to complete handoff.

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

Before reserving a format message, the controller freshly binds the original
session and latest immutable source, then attaches bounded **whole** existing
agent messages as JSON-quoted untrusted data with exact activity/time/content hash.
Provider session creation time, when supplied, is the lower activity bound:
controller `started_at` is a later binding checkpoint, not the session's creation.
Invalid/ambiguous/foreign/future/rewritten source fails closed. Credential-containing
messages are omitted entirely, never redacted under the original bytes' hash.
Bounded omissions are not evidence that notes do not exist. This material is not a
stale report fallback or owner approval; the worker must author a new complete
report without changing scope or inventing observations. If neither retained notes
nor supplied material contain actual observations, an honest unavailable response
remains unaccepted. Send acknowledgement alone proves neither resume nor intake.


### Resolving a failed main synchronization

Inspect **Autonomous Sync Main** and its `autonomous-sync-preparation-<attempt>` /
`autonomous-sync-result-<attempt>` artifacts. Preparation contains
`sync-preparation.json`; final outcome contains `sync-result.json`, including no-op,
blocked and failed outcomes. Monitor reads the same final member from retained
artifacts. Missing payload remains unknown, not invented success. The candidate
branch is unique to the run; cleanup only deletes that owned ref if its SHA still
matches. A conflict, failed gate or moved head leaves live lab unchanged. Disabling
the loop during verification also prevents publication.

Fix the reported conflict or failing check, then review the durable frontier before
explicit admission of another sync on `main`. A spent unknown/prepared/finalize
claim is not a retry capability; reconcile actual effects under a separately
reviewed operation instead of renewing it. Optional `main_sha` and `lab_sha` pin
the expected current heads. A failed sync suppresses automatic retries for that
main revision. No branch protection is weakened, no force
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

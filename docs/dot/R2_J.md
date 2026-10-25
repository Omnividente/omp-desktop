# R2-J: versioned source-only Jules-controller maintenance

## Status and source policy versioning

**This v2 source preparation does not activate v2.** Product R1 remains inactive
and is not a prerequisite. The existing v1 authority is proposal-only; it cannot
be enlarged by changed documentation, a new policy on `main`, a PR body or green
CI. Source publication and owner bootstrap integration are not a standing grant.
The bootstrap branch `feat/dot-r2-j-autonomous-integration` is a separately
requested governance change, not a second standing Dot task or a budget reset.

The immutable-by-protocol policy versions are:

| Effective grant | Accepted source policy | Maximum integration authority |
| --- | --- | --- |
| Legacy schema 1 grant | [r2-j-policy.json](r2-j-policy.json), schema 1 | Own source Draft/proposal only; final owner integration. |
| New schema 2/version 2 grant | [r2-j-policy-v2.json](r2-j-policy-v2.json), schema/version 2 | Independently reviewed source-only Ready and protected exact-head squash. |

Keep legacy policy bytes and old grant records unchanged. A new authority version
requires a new policy path, canonical hash, separate owner acceptance and new
immutable grant/index; never reinterpret or edit an issued v1 grant into v2.
Read policy bytes only from accepted `main`, not the candidate branch. Canonical
JSON uses sorted keys, UTF-8, compact separators and no NaN;
`dot_authority.digest()` is the reference. Keep payload and its hash in separate
records, not a self-referential hashed object.

The owner control record is [issue #146](https://github.com/Omnividente/omp-desktop/issues/146).
Its live index, not this document's status text, selects effective authority.
The existing GitHub write plugin is confirmed: do not reconnect it, request new
credentials, start Codex/Work, invent a provider/API/server/daemon, change OMP
runtime/configuration or pause Jules. Shared `Omnividente` identity is procedural,
not server-enforced isolation or proof of who authorized a request.

## Version-aware effective-grant fetch

Before selection, every mutation, review/Ready/merge preflight and handoff:

1. GET the actual open #146 issue/index, the referenced grant comment/export and
   **all** issue-event/revocation pages; verify repository, immutable comment ID,
   grant ID, canonical payload hash, separate acceptance and validity period.
   A closed, inaccessible, malformed, revoked or conflicting record permits only
   read-only observation/reconciliation. Actor/labels/PR prose are not authority.
2. Select by the **verified grant**, not the newest source policy. Schema 1 uses
   the legacy policy and stays proposal-only. Schema 2/version 2 must name
   `policy_path=docs/dot/r2-j-policy-v2.json`, match its accepted canonical hash,
   and match index `schema=2`, `policy_version=2`, current grant ID/hash/comment.
   Its `supersedes_grant_id` must identify the preserved, explicitly revoked v1
   grant. Reject unsupported versions and mixed index/grant/policy/state tuples.
3. Fetch that policy and the accepted validator/rules from current accepted
   `main`; check acceptance lineage and immutable policy hash. Newer docs may
   describe v2 while the live v1 grant still prohibits Ready/merge. No mutation
   is authorized during a partially published activation or state migration.
4. GET Dot's state and actual blob SHA, match its grant/schema, resolve existing
   task/lease/intents first, then refresh actual main/owned head, complete open-PR
   and file/rename inventories, semantic overlap, scope and cumulative counters.
   No cached checkpoint or previously green run establishes current authority.

## Standing source scope

Without asking per task, an effective grant permits problem selection and
deduplication, investigation, development, synthetic regression tests, own Draft
publication and budgeted revisions. V2 additionally permits `request_review`,
`ready_for_review` and **only** protected `squash_merge` under the integration
contract below. Future in-scope controller merges need no routine owner approval.

- `scripts/autonomous/**/*.py`: Jules Python-controller source and tests,
  including provider clients/dispatch, lifecycle, journal/CAS/state store,
  admission, provenance, continuation, sync and recovery implementations.
- `docs/autonomous/**`: associated technical text, never a disguised change to
  grants, owner decisions or operational permissions.
- Source fixes to execution-authority implementations are allowed, including
  critical safety fixes; issuing/changing **live** execution authority is not.

No standing edits to workflows, governance, `AGENTS.md`, this directory,
`autonomous-project.json`, dependencies/lockfiles, product UI/Rust/IPC/auth/
persistence/updater or OMP runtime/configuration. All `scripts/autonomous/dot_*.py`
helpers/validators/tests are governance, not autonomous source-maintenance scope.
Do not publish workflow/governance changes under this grant. No live Jules
queue/journal/ref/session/receipt writes, provider POST/sendMessage, manual Actions
dispatch/rerun/cancel/enable/disable, loop switch, settings/secrets, self-approval,
generic merge, auto-merge, bypass, releases/tags/bundles/install. Prepare a
source-only recovery plan if needed; do not execute live recovery. These
exclusions still require separately scoped authorization, even during an incident.

## Limits and durable work state

One active controller task and one active PR across all Dot work: v1 Draft only;
v2 Draft **or Ready** (`limits.active_prs=1`). Initial source branch is
`dot/jules-<task-id>`, `base=main`, initial PR `draft=true`. Per task: **10 files,
1000 cumulative additions+deletions, three CI-driven revisions after initial
publication**. Count the union of touched old/new rename paths and failed/reverted
line work, not final net diff. Each later source-change batch consumes a revision;
metadata-only updates do not. Reserve a batch once before its first effect and
reuse that reservation across edit/test/commit steps. Never split/rename/replace
a task or close/reopen a PR to reset counters.

Own metadata only: branch `dot/r2-j-state`, file `dot-state.json`, no product PR.
Keep original task identity/base, active PR/head, counters/batches, full operation
history, backlog, retired tasks, actual heartbeat and receipts there, never in
Jules state. Existing schema 1 state is migrated, **not reinitialized**. V2 uses
schema 2 and its new grant ID; preserve all original timestamps/history. Set UTC
`last_sweep_at` only after an actual completed sweep.

Use the existing plugin's expected-file-blob-SHA CAS with the freshly GET-observed
`content.sha`. Only a successful lease claimant may mutate its active task; a
second invocation observes read-only. Release a known lease at a checkpoint;
waiting for CI does not hold it. Stale leases never authorize takeover. Before
each source push re-read authority/main/head, complete PR/file/rename inventory,
semantic overlap and scope/counters. Use non-forcing expected-head updates,
create-if-absent branch/PR operations and exact readback; no direct main ref write.

For **each** external effect, first CAS-persist exact intent/request digest,
expected refs/file SHA and one consumed send claim. Send once, GET-confirm the
exact result and retain receipt. Timeout/lost ACK/restart with unfinished claim
means GET-only reconciliation; absence, rejection or ambiguity never authorizes
resend, replacement PR/branch or resetting an intent. An unknown intent CAS means
no downstream effect. Use the consolidated exceptions policy below.

## Independent review and protected integration

### Reproduction and genuine hosted CI

Reproduce with real failing-before/passing-after isolated synthetic regression
or smoke. Never run candidate controller CLI against production, real HOME,
sessions or inherited operator credentials. Existing isolated execution or the
secret-free ephemeral PR Control CI is sufficient; a local shell in Dot is not
assumed. If necessary, publish a regression in the same Draft, observe its actual
failure, then fix it in a reserved revision. No manual Actions or fabricated pass.

Refresh the complete authority/task/counter/change/inventory/rename/freshness/
overlap packet and actual PR repository/number/branch/head/base/current-main.
Changes include regular-file mode/binary status; `changes` is the unreserved batch
delta, empty for metadata/checkpoint operations. Preserve original `task.base_sha`;
current verified base belongs in integration evidence, not a silent identity reset.
Prove source head, tested merge SHA, both parents and tested tree from actual
checkout logs, not a guessed `refs/pull/*/merge` name.

Authenticate the existing workflow paths, repository, PR event/number, run IDs,
latest attempts, workflow jobs/check runs and real checkout provenance:

- `.github/workflows/pr.yml`: required Ubuntu and Windows Quality Gate jobs.
- `.github/workflows/autonomous_control_ci.yml`: Control validation job.
- `.github/workflows/codeql.yml`: current JavaScript/TypeScript and Rust analyses.

Use the latest observed run/attempt per workflow: a newer pending/failing run
invalidates an older green. CodeQL does **not** analyze this Python controller
and is neither independent Python semantic review nor a substitute for regression
or safety execution. Independent normal Jules runs on the same main SHA are not
part of this CI proof. Never alter existing workflows to manufacture eligibility.

### Ordinary versus critical automatic review

The following provider-receipt contract remains effective for policy v2. Only a
new owner-issued grant bound to policy v3 may use the alternative below.

Classify exact full diff and independently assessed behavior. Any production
Python change defaults **critical**; modified/deleted tests and operational docs
are critical. Pure additive tests may be ordinary. Admission, provenance,
journal/CAS/state store, dispatch/POST, lifecycle, recovery and authority checks
cannot be downgraded by the author or a reassuring PR body.

- Ordinary: one independent automatic code-review execution.
- Critical: that code review **plus a distinct independent safety/test execution**
  with executable failure-boundary scenarios and actual results. Critical is not
  shorthand for mandatory owner approval; verified stronger automatic review
  permits the same protected integration path.

Use existing native read-only reviewer/Astra execution only if its actual tool
results establish provider-created execution/context identity, original trace or
receipt URI, read-only scope, and separation from the author (and, for the safety
execution, from the code-review execution). The exact input-manifest hash must
bind repository, base/head, tested merge/tree and **all** paths/blob hashes, with
full review coverage, explicit approved verdict, no unresolved findings, risk and
test-sufficiency assessment, and executable test references/results. Recollect
reviews when head/base/tested tree changes or risk/coverage changes.

Primary provider/tool observations must authenticate origin/independence: an
author-written receipt, pasted PR text, boolean `independent=true`, another prompt
in the author's context or same-context self-review does not. Standalone Python
validators check supplied evidence but cannot authenticate remote execution.
If existing native execution cannot expose verifiable separate context/read-only
identity, provenance or sufficient safety results, block Ready/merge and report
one safety exception. Do not invent a provider/API/receipt or replace the stronger
review with routine owner approval merely because the patch is critical. Local
Codex is not a mandatory everyday author/reviewer.

### Ready and single protected exact-head squash

Read current raw branch rules/protection and satisfy strict up-to-date required
checks, required reviews and resolved threads. No pending review requests or
changes requested may remain. Verify current PR base equals current main, head
equals the task head and the exact reviewed/tested merge parents/tree still match.
Do not weaken rules, forge GitHub approval, self-approve or enable auto-merge.

1. Run the accepted v2 preflight on actual primary-source observations. Persist
   `prepare_operation(..., kind="ready_for_review", ...)` intent by state CAS.
   Use the existing GitHub write-plugin tool exactly as exposed:
   `mark_pull_request_ready_for_review(repository_full_name, pr_number)`.
   The stored request is `{"tool":"mark_pull_request_ready_for_review",
   "arguments":{"repository_full_name":"Omnividente/omp-desktop","pr_number":148}}`
   for #148; bind the actual number for any other task. Keep the unique
   `operation_id` in the intent and its digest; the request digest covers only
   the actual tool name and these two arguments. Do not add unsupported args.
   GraphQL's optional `clientMutationId` is correlation only, not an idempotency
   key or atomic expected-head check, and is **not required by this contract**.
   After successful intent CAS/readback, GET the actual repository, PR number,
   node ID, branch, exact head/base and open/unmerged/Draft status immediately
   before the single call. A CAS conflict, unknown CAS or changed/missing refs
   means **no Ready call**, not a new intent or stolen lease. Immediately after
   the call, GET the same identity/head/base and open/unmerged/Ready status and
   reconcile the original operation. ACK alone never proves Ready. Unknown ACK
   permits only GET reconciliation, never another Ready; changed refs cannot
   confirm the operation or authorize merge. The tool has no atomic head arg.
2. Observe required CI **again after Ready**: Quality Gate may run on this event.
   Await the latest authentic runs/attempts; retain Ready event/receipt and the
   newly observed required CI run identities rather than reusing Draft greens.
   Confirm Ready for the same head/base from the original consumed operation,
   then refresh authority, full inventories, independent code/safety receipts,
   branch rules and exact base/head/tested tree before merge. A Ready ACK or
   confirmed Ready alone never authorizes squash.
3. CAS-persist `prepare_operation(..., kind="squash_merge", ...)` for that exact
   preflight. The sole merge operation is protected GitHub
   `PUT /repos/Omnividente/omp-desktop/pulls/{number}/merge` with
   `{"sha":"<exact_head_sha>","merge_method":"squash"}` via existing capability.
   No generic merge, automatic repeat, admin/bypass, force or direct ref write.
4. Treat even a successful acknowledgement as requiring actual GET proof; unknown
   outcome preserves the consumed intent and excludes all next work. Follow
   postmerge reconciliation below, never send the merge again.

## State/evidence API contract and postmerge proof

The shared contract is implemented by accepted
[`dot_authority.py`](../../scripts/autonomous/dot_authority.py),
[`dot_merge.py`](../../scripts/autonomous/dot_merge.py) and
[`dot_state.py`](../../scripts/autonomous/dot_state.py). `check --policy ...
--input ...` and `dot_merge.integration_check(policy, packet, now)` validate the
complete actual-evidence packet; helpers do not fetch, schedule, authenticate a
provider, mutate GitHub or issue execution capability. Native Dot performs the
equivalent preflight using primary plugin/provider observations.

Use the shared state functions, not a second independent state protocol. They
return deep-copied state, preserve inputs and raise `ValueError` for unsafe input;
the caller owns actual GETs and exact-blob CAS writes:

- `prepare_operation(state, kind, evidence, *, operation_id, lease_id, now)`:
  require schema/grant/task/PR/branch/head and actual lease match, no pending
  operation, accepted current-policy preflight. Bind current base, tested merge/
  tree, policy/preflight digests and `expected_state_blob_sha`; persist consumed
  intent before send. Reject duplicate task/kind/head even with a new operation ID.
- `reconcile_operation(state, observation, *, now)`: Ready settles only the
  exact same open/unmerged PR with `draft=false`. Merge requires actual merged/
  closed PR identity, exact branch/head/base, merge commit SHA/time, commit whose
  sole parent is expected base and whose tree is the tested tree, actual current
  main/ancestry comparison, installed merge tree and current-main changed blobs.
  Keep evidence URIs and confirmed receipt in full operation history. Matching
  merge clears pending and sets `phase=post_merge`; it does **not** retire task.
  Unknown, mere `merged=false`, missing or mismatched evidence keeps the original
  intent pending. Only a primary authenticated **explicit rejection** bound to
  that operation/PR/head may settle as `status=rejected`, clear pending and return
  the same task to `review_required`. Its old send claim remains consumed: never
  resend or relabel that task/kind/head. Any safe later operation requires a
  legitimately changed head within preserved revision/line budgets and full new
  preflight/review/CI; rejection is not an automatic retry or counter reset.
- `complete_task(state, post_merge, *, now)`: require confirmed exact receipt,
  `phase=post_merge`, no pending operation, actual main containing merge and
  matching installed changed blobs. Authenticate successful completed **push**
  runs for all three standard workflow paths on the exact `merge_commit_sha`,
  with distinct IDs/latest attempts and evidence URI. Archive the full task plus
  completion evidence, append its ID to `retired_task_ids`, preserve all counters/
  operations/backlog, then clear active task and its matching completion lease
  (`post_merge.lease_id`). Repeated completion raises `ValueError` without a second
  archive entry. Only the confirmed completed state permits the next task.
- `migrate_state(state, new_grant, acceptance, *, expected_blob_sha, now)`:
  owner-only preparation described below. It prepares bytes, not a remote write.

After squash, GET the actual PR, merge commit/parent/tree, main and ancestry,
installed changed-file blobs and exact postmerge CI. If main moved, independently
prove ancestry and unchanged installed task blobs; do not assume a matching tree
on a later main. Pending/failed/mismatched/unavailable postmerge CI or uncertain
CAS means no retirement or new task. Preserve `post_merge`/pending state and
continue GET-only observation. Do not modify Jules state to force completion.

Keep a consolidated PR evidence record: immutable grant/version/hash/decision,
task, reproduction, complete paths/renames and overlap, original/current bases,
head/tested merge/tree, risk, primary independent review receipts, genuine CI
runs/attempts/checkouts, counters, operation receipts and final postmerge proof.
A changed revision withdraws old eligibility; PR prose is never authority.

### One-time acceptance of the Ready transport correction

This narrowly scoped governance correction changes only the unsupported Ready
transport requirement; it does not add actions or weaken v2 evidence/merge gates.
Record one separate owner acceptance of the exact checked correction PR/head,
base, installed main/tree, successful check identities and its sole scope outside
the Dot-editable PR body. Bind the effective grant ID/canonical hash, unchanged
policy path/hash and existing task/PR/branch/counters. Retain the user's explicit
instruction as the decision source; shared GitHub actor is not independent review.
Publish installed-main/post-CI proof as completion of that same decision.

The v2 policy JSON, action set, scope and state schema are unchanged, so this
transport correction does **not** reissue, edit or reinterpret the immutable
grant/export. The separately accepted implementation amendment supplies its
provenance. Do not rewrite existing operation requests/digests or turn an old
unknown/rejected intent into a fresh claim. Pending old-transport effects require
GET-only reconciliation under their original accepted source; if unavailable,
stop with that concrete exception. Preserve all opaque operation history.

If a later correction changes policy/hash/authority, it is a different acceptance:
stage only the Dot index, GET-reconcile and freeze a full quiet state/blob, issue
a distinct immutable grant retaining the new exact acceptance, explicitly revoke
the superseded grant, and prepare an owner-authorized exact-blob CAS replacement
that changes only grant binding/lineage while retaining the complete schema 2
task, original refs, operations, receipts, backlog and budgets. Never reset to
schema 1 or call the legacy-to-v2 migrator on schema 2. Unknown/conflicting CAS is
GET-only; do not activate the existing hourly task against mixed bindings. This
conditional procedure is not permission to execute another policy migration.


## One owner acceptance: bootstrap, new grant/index and CAS migration

This is a procedure for later authorized activation, **not a claim it occurred**.
It uses one owner approval of the new regime, not per-task source approvals:

1. GET the exact bootstrap PR/head/base, complete source diff, genuine required
   CI/review evidence, live #146 v1 authority and full Dot state/blob SHA. Resolve
   any current lease/pending effect by GET-only reconciliation first; require
   `lease=null`, `pending_operation=null` and no active unresolved operation.
   Preserve historical receipts (including `get-confirm-required`); do not invent
   a resolution or erase operations to make migration appear quiet.
2. Retain **one separate owner acceptance outside the Dot-editable PR body** of
   that exact checked bootstrap revision, v2 policy/hash/scope/review/protection
   contract and shared-identity boundary. It explicitly authorizes protected
   bootstrap integration, issuance of the new immutable v2 grant/index, revocation
   of the old grant, same-task adoption via exact-blob CAS and editing the existing
   hourly task in place. It also authorizes freezing the old writer through the
   owner index and binding the final quiet-state snapshot after bootstrap. Retain
   old grant ID and adopted task/PR/head; source head/base or adoption changes
   invalidate acceptance, never silently substitute a different task or revision.
3. Merge only the checked bootstrap through normal protections, with no bypass
   or self-approval. GET-confirm actual main commit/parent/tree/installed files
   and genuine successful post-main CI. Retain accepted PR/head/base/main, tested
   merge/tree, run IDs/latest attempts and the original owner decision URI.
   The autonomous grant cannot merge the governance bootstrap that creates itself.
   Then owner sets the #146 index to non-active `status=staged` (or the accepted
   schema's non-active migrating state), retaining all old pointers/revocations,
   and GET-confirms it. This freezes v1 effects without closing #146 or stopping
   Jules. Finish GET-only reconciliation of any already-issued effects and require
   the quiet-state preconditions again. Only now GET the **final** full old state
   and live blob SHA; bind that SHA, canonical digest of the entire state and
   same task/PR/head in the acceptance/migration manifest before grant generation.
   This postmerge/freeze evidence mechanically completes the one authorized
   decision, not a second routine approval. Unexpected source/adoption changes
   are an exception; never use a pre-bootstrap snapshot as the final CAS target.
4. From accepted `main`, prepare new immutable grant bytes with the accepted
   validator. Acceptance JSON includes `decision=accept`, `decision_ref`,
   `accepted_pr`, `accepted_head_sha`, `accepted_base_sha`, `accepted_main_sha`,
   successful exact-head `check_runs` (`run_id`, `attempt`, `head_sha`,
   `conclusion`), `supersedes_grant_id`, `expected_state_blob_sha`, `state_sha256`
   (canonical digest of the **full** final quiet state), `adopted_task_id`,
   `adopted_pr` (integer PR number), and `adopted_head_sha`. The generated grant
   retains this same complete acceptance; migration rejects a different one.

   ```sh
   python scripts/autonomous/dot_authority.py prepare-grant --policy docs/dot/r2-j-policy-v2.json --input owner-acceptance-v2.json --out r2-j-grant-v2.json
   ```

   The command refuses overwrite and neither publishes nor activates. Require
   `schema=2`, `version=2`, new `id=r2-j-v2-<32hex>`,
   `policy_path=docs/dot/r2-j-policy-v2.json`, its canonical `policy_sha256`,
   `supersedes_grant_id`, exact acceptance, UTC issuance and explicit
   `expires_at=null` (until revoked). Retain exact bytes/export and canonical hash:

   ```sh
   python -c "import json,sys; sys.path.insert(0,'scripts/autonomous'); from dot_authority import digest; print(digest(json.load(open('r2-j-grant-v2.json',encoding='utf-8'))))"
   ```

5. Owner publishes these exact new bytes as a **new** #146 grant comment, retains
   immutable comment ID/URI/export/hash and preserves the old comment/export.
   Update the owner index in the **body/description of #146** to `schema=2`,
   `policy_version=2`, `status=active`, actual repository and
   `grant={id,sha256,comment_id}` for the new grant. Preserve all existing
   `revoked_grants` and explicitly add the superseded v1 grant ID. Never edit the
   old grant/policy, remove revocations or close/reopen #146 as a migration trick.
   A new comment without a matching index cannot activate it.
6. Prepare `migrate_state(...)` with the fresh complete schema 1 state, new grant,
   matching acceptance, `expected_blob_sha` and actual UTC. Preserve active task
   ID/branch/**original base**/head/paths, spent lines/revisions/batches, full
   operations including historical receipts, backlog and timestamps. Set schema
   2/new grant ID, append owner migration lineage with old grant and snapshot
   identity; active task becomes `review_required`, never v2-accepted by old
   handoff. New grant does not reset any counter.
   Prepare an input JSON with `state` (the full frozen snapshot), `grant` (the
   issued new export), `acceptance` (exactly its retained acceptance) and
   `expected_blob_sha` (the live old blob). Generate the CAS candidate, not a
   remote write:

   ```sh
   python scripts/autonomous/dot_authority.py migrate-state --policy docs/dot/r2-j-policy-v2.json --input owner-migration-v2.json --out dot-state-v2.json
   ```

   The command refuses overwrite and validates accepted policy/grant binding.
   Never run candidate controller code with operator credentials for this step.
   After inspecting the generated candidate, owner uses the existing GitHub
   content-file update capability for **only** `dot/r2-j-state:dot-state.json`,
   with old `content.sha` as the `sha` precondition and generated bytes as content.
   Do not create another branch, overwrite the live Jules queue or retry an
   unknown CAS. Then GET-prove the exact candidate bytes and new blob SHA.

   A CAS conflict or unknown acknowledgement stops activation; GET-only, no
   overwrite or lease stealing. Require installed lineage and effective grant
   tuple to match before updating the scheduled task.
7. In the existing Dot chat/Tasks UI, apply the Russian edit-existing-only
   instruction below once under that acceptance. Retain actual task identity,
   name/schedule/account/plugin and first genuine run/result. Until grant, state
   and task readback agree, do not declare unattended v2 active. Source preparation
   alone changes no live task, grant, state, workflow or Jules setting.

To revoke, owner closes #146 and pauses the existing native task, optionally
retaining a separate revocation record with grant/hash/UTC/reason/task/PR. Dot
checks all events and revoked IDs before every effect. Closure at/after issuance
permanently revokes that grant even if reopened; reactivation requires a new
explicit grant after the last closure. Preserve source PRs/history/unknowns;
revocation does not stop Jules/Actions or unsend requests. GET-reconcile in-flight
operations only, never live recovery.

## Concrete adoption of the same #148

Observed before v2 bootstrap (historical snapshot, not future authority):

- [PR #148](https://github.com/Omnividente/omp-desktop/pull/148), open Draft;
  task `terminal-worker-observation-20261025`, branch
  `dot/jules-terminal-worker-observation-20261025`.
- Head `41e16f1c096c72006a986bd7f5de877d9e11b104`, original base
  `0ea918ce7dfef1c26548772f7a3ec950f1449706`.
- Four controller paths: `scripts/autonomous/lab_controller.py`,
  `scripts/autonomous/lab_controller_test.py`, `scripts/autonomous/loop_health.py`,
  `scripts/autonomous/loop_health_test.py`; `spent_lines=79`, `ci_revisions=0`.
- Old grant `r2-j-5ced6a1fb5fa4440a69023073c964abf`; observed state blob
  `d3ebf8b9bdb3fb09068ffd26252c6125ba3e8c62` is **not** a future CAS constant.
  No GitHub reviews were observed; old body/state's no-blocker claim lacks v2
  independent execution provenance and cannot be inherited as v2 review.

After the one accepted bootstrap/grant/index/migration above, Dot resumes **the
same #148/task/branch**. Re-read actual state/PR/main first. Preserve the original
base and all spent work. Reserve **one** of three CI revisions before refreshing
the owned branch onto accepted new main using the existing GitHub non-forcing
update-branch/merge capability with expected current source head. Record intent,
GET-confirm new head/parents and CAS checkpoint. No reset, force, automatic close
or replacement PR. Accepted-main governance files inherited by this base refresh
are not Dot-authored task changes: verify the complete source PR delta against
new main and keep the task's source-path union/cumulative-work ledger intact.
Do not charge inherited bootstrap lines or count one reserved batch twice;
additional Dot-authored work still consumes its actual cumulative line budget.

For this refresh `ci_revisions` becomes 1 (two remain), provided actual counters
still match; a stale snapshot cannot authorize this calculation. Recompute all
PR/file/rename/semantic overlap, classify the production Python patch critical,
redo independent code review **and distinct safety/test execution**, actual
regression/safety results and genuine hosted CI on the exact new base/head/
tested merge/tree. Old review/CI cannot be relabelled for the new revision.
Then expected-head Ready, observe latest Ready CI, refresh full preflight,
protected exact-head squash, actual GET main/commit/installed blobs and postmerge
push CI, record completion and retire this task. Only then select the next task.
Conflicts, unverifiable review, unsafe counters or unknown operations use the
exceptions policy; they do not trigger a new task, reset or routine owner approval
just because the source is Python/critical.

## Consolidated exceptions and notifications policy

Use one policy across selection, authoring, review, Ready, merge, migration and
postmerge: stop new effects/next-task selection on inactive/revoked/mixed authority,
incomplete/denied/stale inventory or evidence, semantic overlap/conflict, limits,
unsafe counters, unresolved findings, unverifiable reviewer origin/independence/
coverage/safety, unsatisfied protections/CI, unavailable expected-head capability,
lease/CAS uncertainty, unknown ACK, platform approval pause or mismatched installed
state. Preserve the same task/PR/counters/intents and complete available GET-only
reconciliation; never retry effects, create replacements, steal a lease, reset
history, invent passed checks/provider receipts or bypass platform approval.

Send **one consolidated exception** with exact grant/task/PR/head/base, concrete
missing primary fact or conflict, consumed operation/counters and safe read-only
next step. Update that exception only for material new evidence. Waiting for
ordinary CI is a checkpoint for later observation, not a quiet-sweep alert.
Keep heartbeat/backlog and one consolidated completion/evidence record; no
routine owner choice/approval, repeated notification per hourly sweep or new
infrastructure. Critical source alone is not an exception. Excluded authority
changes need separately scoped authorization, not a per-task approval shortcut.
Keep Jules working throughout.

## Native ChatGPT hourly task: edit existing only

The owner uses the existing Dot conversation and native
[Tasks UI](https://chatgpt.com/schedules/profile) (also profile → scheduled tasks).
These are management UIs, **not an API**. The actual task ID is not in current
GitHub state; do not invent one or claim the live task was updated by this PR.
Retain actual ID/name/hourly schedule/account/plugin on edit; no create call,
duplicate task, alternate scheduler/server/daemon, Work or Codex automation.
If the existing task cannot be identified unambiguously, report that concrete
exception and do not create a replacement.

The existing hourly schedule is retained, not recreated from an example cron.
Do not promise timing/concurrency/unattended availability from prompt text.
Tasks must fetch repository rules/authority on every run rather than rely on
uploaded/project files or inherited custom instructions. Platform-required
approval pauses are exceptions, never grounds for a new token or bypass. The
confirmed write plugin is not the standard read-only GitHub app; no routine
connection/access re-investigation.

Send this exact edit instruction once during authorized activation:

```text
ИЗМЕНИ ТОЛЬКО СУЩЕСТВУЮЩУЮ почасовую задачу R2-J в этом чате Dot/нативном
ChatGPT Tasks. НЕ СОЗДАВАЙ новую задачу или дубликат; не вызывай создание.
Сохрани её фактические ID, имя, почасовое расписание, аккаунт и уже подключённый
GitHub write-plugin. Если существующая задача не найдена однозначно, сообщи
конкретное исключение и ничего не создавай. Не запускай Work, Codex, сервер,
демон, новый scheduler, API или повторное подключение. Замени инструкции
существующей задачи следующим текстом и покажи фактическое подтверждение
редактирования с её реальными ID/ссылкой и сохранённым расписанием. Не утверждай
обновление или активацию без наблюдаемого результата.

При КАЖДОМ запуске общайся с владельцем по-русски. В Omnividente/omp-desktop
сначала прочитай живой индекс issue #146, указанный неизменяемый grant/export,
его canonical hash и все события отзыва. Загрузи AGENTS.md, docs/dot/WORKFLOW.md,
docs/dot/R2_J.md и политику с принятого main по версии/пути/hash именно этого
grant, не просто новейший JSON. Schema 1 использует docs/dot/r2-j-policy.json:
только proposal/Draft, без Ready/merge. Schema/version 2 использует
docs/dot/r2-j-policy-v2.json: нужны новый grant, index schema=2/policy_version=2,
явно отозванный старый grant и совпадающая мигрированная state schema=2.
Нет действительного согласованного grant — только чтение, без мутаций.
Не выдавай и не расширяй собственную власть; R1 неактивен.

Прочитай dot/r2-j-state:dot-state.json и фактический blob SHA; сначала продолжи
ту же задачу/PR и GET-сверку незавершённых операций. Не захватывай чужую/старую
lease, не создавай вторую задачу/PR и не сбрасывай бюджеты/историю. Для #148
после принятой владельцем v2-миграции сохрани ту же task/branch/PR и старые
счётчики; обновление ветки на принятый main требует expected-head без force и
одного заранее зарезервированного CI-revision, затем полного нового review/CI.

Самостоятельно дедуплицируй полные PR/file/rename списки и смысл изменений,
исследуй и воспроизводи ошибки Python-контроллера Jules, исправляй исходники и
синтетические тесты в своей dot/jules-* ветке/Draft в main. Лимиты: одна активная
задача и один PR (v1 Draft; v2 Draft или Ready), <=10 файлов, <=1000 накопленных
additions+deletions, <=3 CI-revisions. Резервируй пакет один раз до эффекта,
считай неудачные/отменённые правки. Только изолированные проверки и настоящий
обычный PR CI, не production CLI, чужие sessions/secrets и не ручные Actions.

Для v2 получи независимый автоматический code review точного base/head/tested
tree и всех paths/blobs. Production Python, изменённые/удалённые тесты и
operational docs — critical: дополнительно отдельное независимое safety/test
исполнение с реальными сценариями границ отказа. Проверяй первичные результаты
существующего native reviewer/Astra: tool/provider identity/provenance, отдельный
контекст, read-only scope, manifest hash, полное покрытие, approved verdict,
отсутствие нерешённых findings и достаточность реальных тестов. Саморевью,
авторская аттестация и CodeQL JS/Rust не заменяют Python review. Если реальная
независимость/достаточность не проверяется — safety exception, без выдуманного
provider/API и без Ready/merge. Critical не требует обычного owner approval.

После полного v2-preflight и проверки живых protections/required checks/threads
выполни один expected-head Ready, заново дождись и проверь настоящий CI Ready,
обнови все evidence и выполни только protected exact-head squash с sha текущего
head и merge_method=squash. Никакого self-approve, generic merge, auto-merge,
bypass, force или прямого push main. При смене head/base/tree review/CI устарели.

Перед каждым эффектом повторно проверь authority, CAS-сохрани intent/digest,
expected refs/blob и единственный send claim. Отправляй один раз, GET-подтверждай
результат. Unknown ACK или CAS — только GET reconciliation, без повторной
отправки, новой ветки/PR или следующей задачи. После merge проверь фактические
PR/commit/parent/tree/main ancestry/installed blobs и push CI всех трёх обычных
workflow на merge SHA; сохрани полный receipt/completion, затем retired task ID
и освободи active task/lease. До полной postmerge proof новую задачу не начинай.

Не меняй workflows/governance (включая dot_*.py), live Jules queue/state/sessions,
execution grants, settings/secrets, runtime, releases/tags/bundles/install.
Используй единый раздел exceptions в R2_J.md: останови новые эффекты, сохрани
задачу/счётчики/операции, закончи доступную GET-сверку и пришли одно сводное
конкретное исключение; обновляй его только при существенных новых фактах.
Ожидание CI — checkpoint, не повод для повторных уведомлений. Сохраняй настоящий
heartbeat/backlog и сводное completion evidence. Не спрашивай обычных решений
или разрешений по каждой in-scope задаче, не сообщай о каждом тихом обходе.
Не объявляй невыполненные проверки успешными. Оставь Jules работающим.
```


## Policy v3 native procedural review (proposed, not activated)

`docs/dot/r2-j-policy-v3.json` retains schema 2 and every scope, budget, CAS,
single-send, CI, protected squash and live-Jules prohibition. Its policy version
is 3. Publishing or accepting source alone does not reinterpret an existing
grant. The old v2 policy remains immutable. Product R1 remains inactive.

The owner-directed amendment allows **two separate actual native executions**
for every change: code review and independent safety/tests. Each is a fresh
`collaboration.spawn_agent` call with `fork_turns="none"`, not the author or any
other task that authored the patch. Record all writer identities. The caller
retains actual invocation arguments and returned canonical task identity, then
the completed agent result. Both receive the identical complete exact
base/head/tested-merge/tree/path/blob manifest. Read-only review and isolated
testing are explicitly instructed; shared filesystem permissions do **not**
technically enforce that scope. Recheck candidate bytes after both executions.

This is `procedural-not-provider-attested` independence. Do not require or
fabricate provider model/context/trace/permission/hash attestations. Local
manifest/report/log hashes detect changed bytes, not provenance. The caller
must compare records with actual primary tool observations and keep a retrievable
transcript reference; author-written JSON, a fixture, a pasted approval, or a
second prompt in the author task is not evidence of independent execution.

For a machine-checkable retained call, its `message` is JSON containing `role`,
`scope="read-only-review-and-isolated-tests"`, the complete `manifest` and
`instructions`. Preserve the exact call, `result.task_name`, and final agent
report JSON as `completion`; do not rewrite the report to make it pass. Reports
retain the existing approved verdict, sufficiency/risk analysis, complete path
coverage, test IDs and absence of unresolved findings. Receipts identify
`origin="native-agent-tool-result"`, `permissions="read-only-task-scope"`
(an instructed boundary only), and the actual execution ID. The validator
checks bindings and exact result content; it cannot authenticate supplied JSON.

Critical safety review must really execute isolated boundary tests and retain
command, exit code, original output and its locally computed SHA-256, exact
head/manifest, and covered test IDs. All existing fail-closed/no-replay/identity/
non-escalation scenarios still require results or justified applicability; at
least one must actually pass. Missing or failed logs cannot become success by
author attestation. Reproduction still requires real failing-before and
passing-after evidence. The two native reviews supplement, never replace,
ordinary GitHub CI and live protection/thread checks. Changed refs, manifest,
bytes or findings invalidate reviews. Unverifiable primary execution, missing
logs or inadequate tests remain a consolidated safety exception.

### Policy v3 owner acceptance and regrant

One formal owner acceptance may authorize the following bounded bootstrap
sequence; Dot must not accept/merge this governance PR or issue itself a grant.
Owner acceptance must bind the exact PR head/base, successful normal CI
identities/attempts, policy v3 canonical hash and the read-back installed main.
This is separate one-time owner work, not standing R2-J authority.

1. Review the exact amendment and its real two-agent/test evidence. Integrate
   through protected owner-directed review/merge; verify installed blobs and
   ordinary push CI. No workflow or protection changes are required.
2. Stage only the Dot authority index so no new Dot effects occur. Leave Jules
   ON. Read the actual Dot blob SHA and full state; require no lease, pending
   operation, unresolved task operation or incomplete Ready/merge/postmerge.
   Reconcile unknown results first; never steal a lease or discard history.
3. Explicitly supersede/revoke the current v2 grant. Prepare a **new** immutable
   grant with `schema=2`, `version=3`, policy path
   `docs/dot/r2-j-policy-v3.json` and its canonical SHA-256. The `r2-j-v2-` ID
   prefix denotes the unchanged schema-2 identity format, not policy version.
   Owner acceptance records the old grant, exact state blob/full canonical hash,
   adopted task ID/PR/head, policy hash and source acceptance. No grant is issued
   by this PR; unknown or mixed bindings remain read-only.
4. Use pure `regrant_state` to prepare schema-2 → schema-2 bytes. It preserves
   the existing task, branch, PR, original base, history, counters, old evidence,
   backlog and retired IDs; changes only the grant binding and phase to
   `review_required`, and appends a migration record. Owner CAS-writes against
   the freshly accepted blob SHA and GET-verifies exact resulting bytes. Old
   evidence is historical, not valid under the new policy. Never rerun a write
   after unknown ACK; GET-reconcile only.
5. Activate the owner index with schema 2, policy_version/grant_version 3, exact
   policy path/hash, new immutable export/hash, explicit old-grant revocation
   and verified migration receipt. Update the **same** hourly task's policy
   selection instructions (no duplicate scheduler). The acceptance may cover
   these owner-executed bootstrap steps as one decision; it is not permission
   for Dot to issue its own authority.
6. Continue PR #148 on the same task and branch, preserving its 4-file/79-line/
   zero-CI-revision historical counters (read live values again). A main refresh
   still reserves one CI revision once before the expected-head/non-force
   effect. Obtain fresh independent reviews and real CI for its new exact refs.
   Existing Ready, protected exact-head squash and full postmerge requirements
   are unchanged; no task retirement or next task before completion proof.

If any bootstrap observation changes, pause dependent activation and preserve
all prior state. Acceptance does not waive safe CAS, unknown-outcome handling,
checks or merge protection, and does not permit live recovery.

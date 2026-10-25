# R2-J: standing Jules-controller maintenance

## Status and effective authority

This is the reviewed contract, **not an active grant**. R1 remains inactive and
is not a prerequisite for R2-J. The bootstrap PR has its own explicit maintainer
publication permission. Activation happens only after separate owner acceptance
of its exact checked revision. Publishing or merging a file alone is not a grant.

The policy is [r2-j-policy.json](r2-j-policy.json). The owner control record is
[issue #146](https://github.com/Omnividente/omp-desktop/issues/146), initially
**staged**. Read policy bytes from accepted `main`, never a candidate checkout.
Bind the effective grant to their canonical JSON SHA-256. Canonical JSON uses
sorted keys, UTF-8, compact separators and no NaN; `dot_authority.digest()` is the
reference implementation. Keep the grant and its hash in separate records.

The existing Dot GitHub write plugin is a confirmed prerequisite. Do not replace
it, request another token, start Codex/Work, create an API/server/daemon or modify
OMP runtime/configuration. Shared `Omnividente` identity is **procedural**, not
server-enforced separation. Neither actor, PR text, labels nor green CI proves
human acceptance. This regime does not claim to remove the account's technical
ability to merge or administer GitHub.

## Standing source scope

Without asking per task, Dot may select/deduplicate a controller problem,
investigate, develop a fix, add synthetic regression tests, publish its owned
Draft, inspect ordinary CI and revise it within the limits. It may read exact
refs, PR/file/rename inventories, runs/attempts/checks and redacted artifacts.
Never collect credentials, private worker prose or user session contents.

- `scripts/autonomous/**/*.py`: the whole Jules Python controller and its tests,
  including dispatch/provider clients, lifecycle, journal/CAS/state-store,
  admission, provenance, continuation, sync and recovery implementations.
- `docs/autonomous/**`: associated textual technical documentation, not a way to
  change effective grants, owner decisions or operational permissions.
- A source proposal touching execution-authority implementations is allowed;
  **issuing or changing live execution authority is not**. Mark admission,
  provenance, journal/CAS, POST, recovery and operational-documentation changes
  critical. Retain an independent review and exact-revision owner integration.
  Local Codex is optional, not a mandatory everyday executor/reviewer. Astra or
  another independent review may supply evidence; authors never self-accept.

No standing edits to workflows/governance, `AGENTS.md`, this directory, the
`dot_authority*` validator/tests, `autonomous-project.json`, dependencies,
lockfiles, product UI/Rust/IPC/auth/persistence/updater or OMP runtime/config.
Workflow proposals may be investigated locally but not autonomously published.
No live Jules queue/journal/ref/session/receipt changes, provider POST/sendMessage,
Actions dispatch/rerun/cancel/enable/disable, loop switch, settings/secrets,
ready-for-review/approve/merge/auto-merge/bypass, release/tag/bundle/install.
Those remain separate owner operations; even an obvious incident needs approval.
Dot may autonomously prepare an exact-identity recovery plan, never execute it.

## Limits and durable work state

One active controller task and one active Dot Draft across all Dot work. Own
source branch: `dot/jules-<task-id>`, `base=main`, `draft=true`. Per task:
**10 files, 1000 additions+deletions, three CI-driven revisions after initial
publication**. Retain the union of touched old/new rename paths and cumulative
line work across failed/reverted revisions, not just the final net diff. Every
later source-change batch consumes a revision; metadata-only updates do not.
Reserve each batch once, before its first effect; reuse that reservation through
its edit/test/commit steps rather than charging the same batch twice.

Keep task IDs, consumed counters, original base, heads, active Draft, backlog,
intents, ACKs and heartbeat in Dot's own state, never the authoritative Jules
queue. The exact metadata exception is branch `dot/r2-j-state`, file
`dot-state.json`; it has no product PR. The owner initializes it after activation
with schema 1 and the grant ID; `active_task`, `lease`, `pending_operation` and
`last_sweep_at` start as null; `retired_task_ids`, `operations` and `backlog` as
empty arrays. Set UTC `last_sweep_at` only after an actual completed sweep.

Use the existing plugin's expected-file-blob-SHA compare-and-swap to claim/update
that one record. Only the successful claimant may mutate its active task. A
second invocation observes the current lease and remains read-only. Release the
lease after a known phase/checkpoint; waiting for CI does not hold it. A stale
lease or uncertain CAS never authorizes automatic takeover. Record one exception
if the previous outcome cannot be reconciled. Closing/reopening a Draft,
replacing a branch or reusing a retired task ID never resets counters.

Before every source push: re-read current grant/revocations/main/owned head,
complete all PR and changed-file pages including both rename paths, investigate
semantic overlap, check scope/counters and prove the owned branch lease. Use
non-forcing expected-head updates and create-if-absent branch/Draft operations.
Changed main/head/base invalidates prior overlap/readiness evidence. An API error,
truncated inventory, conflict or unknown acknowledgement stops mutations, not
Jules. No force-push, replacement branch, blind ref update or alternate launcher.

For **each** external effect persist its exact operation intent/request digest,
expected ref/file SHA and one consumed send claim in the state first. Make one
call, then read back the exact ref/commit/Draft identity, parent and planned
content. Persist the receipt. On timeout/lost ACK, or restart with an unfinished
claim, first reconcile GET-only. A uniquely matching actual result may settle the
original intent; absence/ambiguity/rejection is not permission to resend. If the
intent checkpoint's own CAS is unknown, do not perform the downstream effect.
The plugin's ordinary result checks apply; this is not another recovery project.

## Tests, CI and handoff

Reproduce with a real failing-before/passing-after synthetic regression or smoke.
Never run candidate controller CLI against production, user HOME, sessions or
inherited operator credentials. A supported isolated synthetic executor or the
existing secret-free ephemeral PR Control CI is sufficient; no local shell in
Dot is assumed. If no local executor exists, publish the regression in the one
Draft, observe its genuine CI failure, then fix it in a budgeted revision. Do not
manually dispatch/rerun CI. Never claim an unexecuted check passed.

Existing `scripts/autonomous/*_test.py` discovery runs the reference validator's
behavior tests without workflow changes. `dot_authority.py` also provides
`prepare-grant` and `check --policy ... --input ...` for owner/offline audits; it
makes no network requests and issues no execution capability. Dot performs the
same preflight from real plugin observations; ChatGPT is not assumed to execute
local Python. The helper validates supplied evidence, not its remote authenticity.
The complete packet includes grant/index/issue/events, task counters, changes
(with regular-file mode and binary status), complete PR inventory, freshness,
semantic-overlap and uncertain-operation status. `changes` is the as-yet unreserved
batch delta; for later metadata/checkpoint checks use an empty delta.

Keep one consolidated handoff on the owned Draft: grant ID/hash/reference, task,
problem, overlap decision, complete paths/renames, exact main/base/head/tested
merge SHA, real checks/run attempts and URLs, counters, critical review and
limitations. A changed source revision withdraws the old ready claim. The owner
chooses final review/integration; Dot never marks ready or merges. While awaiting
acceptance, continue read-only diagnosis/backlog, not another Draft.

## One owner acceptance: issue, activate and revoke

1. Review the exact bootstrap head/base, all required CI and this shared-identity
   procedural boundary. Retain the acceptance outside the author-editable PR body.
   The decision covers this R2-J version and setup, not future product merges.
2. Integrate that checked PR through normal protections. Retain accepted PR,
   head/base/main SHAs, tested merge SHA where applicable, all required check run
   IDs/attempts and the independent owner decision URI. No bypass or self-approval.
3. Prepare an immutable export using the accepted validator and an acceptance
   JSON with `decision=accept`, `decision_ref`, `accepted_pr`, `accepted_head_sha`,
   `accepted_base_sha`, `accepted_main_sha`, and `check_runs` entries containing
   `run_id`, `attempt`, `head_sha`, `conclusion=success`:

   ```sh
   python scripts/autonomous/dot_authority.py prepare-grant --policy docs/dot/r2-j-policy.json --input owner-acceptance.json --out r2-j-grant.json
   ```

   This command refuses overwriting an export. It does not activate or publish.
   Retain the bytes and **canonical** hash, not `sha256sum` of indented JSON.
   A grant has an immutable ID/version,
   exact acceptance, policy hash, UTC start and explicit `expires_at=null`
   (standing until revoked). A changed record requires a new owner decision.

   Compute the index hash from the generated export:

   ```sh
   python -c "import json,sys; sys.path.insert(0,'scripts/autonomous'); from dot_authority import digest; print(digest(json.load(open('r2-j-grant.json',encoding='utf-8'))))"
   ```

4. Owner posts those exact bytes as a grant comment in #146, retains its immutable
   comment ID/URL and export/hash, then changes the owner index JSON **in the
   body/description of issue #146** to schema 1,
   `status=active`, the repository, `grant={id,sha256,comment_id}` and
   `revoked_grants=[]` (preserve existing revocations on subsequent grants).
   Hash verification detects editing/deletion; a comment alone or Dot work-log
   cannot activate anything. Initialize the separate Dot state described above.

   Generate its exact initial JSON with the real issued grant ID (no template ID):

   ```sh
   python -c "import json; g=json.load(open('r2-j-grant.json',encoding='utf-8')); print(json.dumps(dict(schema=1,grant_id=g['id'],active_task=None,lease=None,pending_operation=None,retired_task_ids=[],operations=[],backlog=[],last_sweep_at=None),indent=2))"
   ```

5. Create exactly one native ChatGPT task with the instructions below. Check the
   confirmation, model/plugin connection, hourly schedule, owner account and first
   real sweep/result. Retain the task identity and first run, not just its prompt.
   Before then the contract is prepared, **not deployed unattended operation**.

To revoke, the owner closes #146 and pauses the task at
[ChatGPT Scheduled](https://chatgpt.com/schedules). Optionally append a retained
revocation record naming grant ID/hash, UTC, reason and affected task/PR. Dot
checks the open index, all issue-event pages and revoked IDs before every effect.
A closure at/after issuance permanently revokes that version, even if reopened.
Reactivation needs a new explicit owner grant after the last closure, never
removal of a checkbox. Unavailable/mismatched authority stops new source writes
and tasks. Preserve Drafts/history/unknown evidence; revocation does not cancel
Jules/Actions or unsend an accepted request. An already-in-flight effect must be
reconciled read-only. Do not stop Jules during activation or revocation.

## Native ChatGPT recurring task

The owner confirmed [Dot](https://chatgpt.com/dots) and
[Scheduled](https://chatgpt.com/schedules), also Dot profile → scheduled tasks.
These are management UIs, **not an API**. Create the recurring task in the Dot
conversation after activation. Do not create another scheduler, server, daemon,
Codex automation or Work/event-triggered task. The ordinary schedule polls CI.

Use an hourly schedule (for example every hour at minute 05 UTC), not the old
proposal's 30 minutes: current [Tasks documentation](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
documents up-to-hourly recurrence for eligible paid plans. Check availability in
the real account. Do not promise timing/concurrency/24-hour execution merely
from a prompt. Tasks cannot rely on uploaded/project files or inherited custom
instructions: fetch these repository rules and live authority on every run.
Platform-required approvals can pause a task; never bypass them with prose or a
new token. The confirmed existing write plugin is not the standard read-only
GitHub app; do not re-investigate/reconnect it as a routine task.

Send the following to Dot once, then verify its native task confirmation:

```text
Create ONE recurring task named "R2-J: Jules controller maintenance", hourly at
minute 05 UTC, in this ChatGPT account using this Dot and its existing GitHub
write plugin. Use the native ChatGPT scheduler only, not Work or Codex.
Communicate with the owner in Russian.

On EVERY invocation read AGENTS.md, docs/dot/WORKFLOW.md, docs/dot/R2_J.md and
docs/dot/r2-j-policy.json from current main in Omnividente/omp-desktop. Verify issue #146,
the exact owner grant/export hash and complete revocation events. If inactive,
unknown or revoked: observe only, no mutation. Never self-issue/extend a grant.

Read/CAS-claim dot/r2-j-state:dot-state.json. Resume the same task/Draft and
reconcile unfinished operations before selecting work. No lease stealing, no
second task/Draft, no reset of consumed budgets. Sweep refs, controller source,
redacted health/evidence and CI through the existing GitHub plugin. Deduplicate
full PR/file/rename lists and semantic intent. If a task is safe and in scope,
independently reproduce, fix, test and publish/update its own dot/jules-* Draft
into main. Scope is the whole Jules Python controller/tests, not product R1.
Reserve <=10 touched files, <=1000 cumulative additions+deletions, <=3 CI-driven
revisions. Use isolated synthetic tests/ordinary PR CI, never production CLIs.

Checkpoint each single-effect intent, use expected-head/file-SHA non-forcing CAS,
verify exact results. Unknown ACK means GET reconciliation, never blind retry or
replacement branch/PR. Check authority again before every mutation. Do not touch
workflows, live Jules state/sessions, grant/governance/settings, execution grants,
manual Actions, ready/approve/merge/release/install. Critical source proposals
need independent review and final owner integration, not mandatory local Codex.

Persist heartbeat, grant/task/PR/counters, CI attempts and backlog; release the
known lease after the phase. While a Draft waits, do read-only sweeps only.
Notify the owner with one consolidated handoff for a checked Draft or an actual
exception (budget/conflict/unknown/permission/platform pause), not routine choices
or a notification on every quiet sweep. Never declare an unfinished report/check
complete. Keep Jules working. Do not create duplicate scheduled tasks.
```

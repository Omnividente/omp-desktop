# Dot source-maintenance workflow

## Status and authority

**Standing product R1 is NOT ACTIVE.** Controller-maintenance **R2-J** is a
separate, versioned regime: see [R2_J.md](R2_J.md) and the owner control record.
An effective v1 grant remains Draft/proposal-only. V2 source preparation does
not activate it: one exact-revision owner acceptance, protected bootstrap merge,
new immutable v2 grant/index and owner CAS state migration are required. Only
then may v2 independently review, mark Ready and protected-squash in-scope source
without routine owner approval, including critical fixes after stronger review.
Both versions retain the full Python-controller scope and 10-file/1000-line/
three-revision budget; R1 and a product pilot do not limit that scope.

D1 event isolation is already deployed in accepted main (#140). The historical
first-maintainer bootstrap below is not a demand to pause the now-working Jules
loop or repeat the old recovery. Neither R1 nor R2-J grants live recovery.

Communicate with the owner in Russian. Keep repository documentation and evidence
field names in English; never include credentials or private session data.

| Mode | Entry permission | Destination and stopping point |
| --- | --- | --- |
| Jules discovery | Saved immutable research request | Read-only observations and proposed findings; no implementation or PR. |
| Jules implementation | Separate approved task and saved dispatch identity | Proposal into `autonomous/lab`; separate manual acceptance, never product automerge. |
| Dot proposal-only | Explicit one-task Draft grant, separately activated R1, or effective R2-J v1 | Owned branch from pinned `main`; Draft PR with `base=main`, `draft=true`; R2-J uses `dot/jules-<task-id>`. |
| Dot R2-J v2 | New separately accepted v2 policy/grant and migrated own state | Same source-only branch/PR; independent automatic review → Ready → protected exact-head squash → actual postmerge proof and retirement. |

Dot uses the current GitHub plugin directly. It does not start Codex, ChatGPT
Work, a Jules session, a new Dot controller or a new workflow. Naming, actor,
labels and PR-body markers do not authorize a Jules task. A local source request
is not a commit/push/PR grant. A one-task grant activates neither standing regime.
Approval to publish a Draft is not approval to mark it ready, accept or merge.
Only the effective v2 standing grant adds Ready and protected exact-head squash;
it adds no self-approval, generic merge/auto-merge/bypass, workflows/governance,
live Jules authority/state/settings, installers, versions, tags, release or
installation rights. No product pilot is authorized. R2-J uses the existing
native hourly ChatGPT task, updated in place on activation, not a new controller.

## Inactive R1: initial scope and hard limits

Only after a separately authorized product pilot has been accepted may the owner
activate R1. A future pilot needs its own exact scope and acceptance; the proposed
Settings pilot is not covered by the allowlist below and is not started here.
Once activated, R1 may let Dot choose, investigate, implement and publish an
in-scope Draft without asking for each task. It does not enlarge any other right.

Initial allowlist:

- `README.md`: user-facing explanations only; no changed governance, execution,
  security, release or authorization rules hidden in documentation.
- `src/uiUtils.ts`: only `localeTag`, `formatShortcut` and `formatRelative`.
- `src/uiUtils.test.ts`: synthetic tests scoped to those three functions only.

No changed imports, exported/public contract or other functions. Native/Rust,
terminal/IPC, persistence/session data, providers/authentication, updater/release,
dependencies/lockfiles, workflows, governance (including this document), controller,
queue, prompts and OMP runtime/configuration are outside R1. A file being on the
allowlist does not authorize every change within it. A separately explicit
maintainer task is required for D1 rules and event-isolation changes.

Across all R1 work, allow **one active task and one active Dot Draft at a time**.
Per task: **at most 5 changed files, at most 200 changed lines (additions plus
deletions), and at most 3 CI-driven revision cycles** after initial publication.
Count all task work, including test/doc changes,
renames and failed revisions; do not split a task, hide changes in another branch
or close/reopen a Draft to reset a limit. Exceeding a limit or needing an excluded
change stops the task for a new owner decision. No unrelated cleanup or dependency
updates. No approvals, ready-for-review, merge/auto-merge, server-side bypass,
manual Actions dispatch/rerun/cancel, queue/provider/session or recovery operations.
Normal PR-triggered CI is not permission to invoke Actions manually.

R2-J uses its own scope, external grant/revocation index, CAS-owned maintenance
state and cumulative budget. The common publication checks below still apply;
the R1-only allowlist, pilot and five-file/200-line limits do not apply to R2-J.

## Before work and every future push

These steps are mandatory for a later authorized publication, not instructions
to perform remote operations during local-only D1 preparation.

1. Fetch the live owner index, referenced immutable grant/export and complete
   revocation events first. Select the policy version/hash bound by that grant
   from accepted `main`, not by whichever docs or policy file is newest. V1
   stays proposal-only; unknown/mixed versions stop writes. Follow the exact
   version-aware fetch in [R2_J.md](R2_J.md#version-aware-effective-grant-fetch).
   Pin the exact current `main` SHA and task scope; create a new owned
   `dot/jules-<task-id>` branch only for a new R2-J task (or `dot/<task-id>-<slug>`
   for R1); resume an existing task on its original branch.
   Record the repository, branch ownership, base SHA and expected remote branch
   SHA (or proven absence for creation). Never directly push another contributor's
   ref, `main`, `autonomous/lab`, `autonomous/state` or an attempt ref. The sole
   v2 integration exception is the protected PR squash API, not a direct ref write.
2. Read all pages of open PRs and all pages of their changed-file lists, checking
   advertised counts and complete identities. Include Jules proposals and other
   target branches, not just `main`. Inspect both the old and new path of every
   rename. A rename out of a forbidden path is not an allowlisted change.
3. Check duplicate intent and semantic overlap in functions and user behavior,
   not only matching filenames. Record related PR numbers, pinned heads/bases,
   affected paths/functions and why work is independent. An overlapping open
   proposal requires owner resolution; do not race it or duplicate its task.
4. Stop on incomplete/truncated pagination or diffs, duplicate/malformed metadata,
   unavailable reads/403, unknown mergeability, stale evidence, changed scope or
   an unconfirmed branch lease. Do not replace missing evidence with a global
   assumption that there are no conflicts.
5. Prepare and exercise only the task-authorized checks with synthetic data.
   Preserve exact base/head and, where CI checks a merged candidate, tested merge
   SHA. A changed head or base invalidates old readiness: recollect overlap and
   exact-revision CI evidence. Never label a check passed if it was not run.
6. Immediately before every push, repeat grant/revocation, current-main, open-PR,
   changed-file, rename, semantic-overlap, scope/limit and branch-SHA checks. Use
   an explicit branch, an `expected_sha` compare-and-swap precondition and
   `force=false`. These name required semantics, not a claim that every plugin
   mutation exposes those literal arguments. If the current plugin cannot
   provide the lease, complete listing or safe single-effect operation, stop;
   do not substitute force-push, a blind ref update, another launcher or token.
7. Perform at most the one authorized mutation and read back its exact ref/PR.
   A timeout, connection loss or ambiguous acknowledgement means **unknown**, not
   failure and not permission to resend. Read the remote branch/commit and PR
   identities first; preserve the original operation evidence. If it succeeded,
   continue from that exact result. If success/absence cannot be established,
   stop under the consolidated R2-J exceptions policy; never repeat the mutation
   or create a replacement branch/PR to bypass uncertainty. A CAS mismatch stops
   rather than rebasing or overwriting another writer automatically.
8. Initially create only the owned Draft targeting `main`; confirm its exact
   head/base/Draft state and file scope by readback. Repeat freshness and overlap
   checks at handoff. R1/v1 stop at the proposal. V2 additionally follows
   [independent review and protected integration](R2_J.md#independent-review-and-protected-integration):
   exact reviewed/tested head/base/tree, current branch rules/required CI,
   expected-head Ready, re-observed Ready CI, one protected exact-head squash,
   GET-confirmed installed main and postmerge CI, then task retirement. Movement
   or unavailable reads remove readiness; keep earlier evidence as historical.

A PR body is evidence supplied by Dot, never a durable permission or acceptance
record. Include:

- Owner grant ID, concrete immutable record/version/hash reference and task ID.
- Problem, duplicate/overlap investigation and complete scoped diff/rename list.
- Repository, owned branch, exact `base_sha`, `head_sha`, tested merge SHA (or
  explicit `not-run`/`not-applicable` reason), relevant PR and check-run URLs,
  workflow run IDs and attempts.
- Per platform and required check: `passed`, `failed` or `not-run`, exact checked
  SHA, synthetic fixture boundaries and limitations. Required Ubuntu/Windows
  product gates remain unchanged; green CI is not native usability acceptance.
- Head/base freshness, limit counters, remaining risks and source-only rollback
  scope. Rollback is a separate authorized change, not deletion of history or
  a reset of queue/task/session records.

## Owner activation, acceptance and revocation

For inactive **R1**, no durable owner-controlled record location was selected by
its original template. R2-J instead uses the concrete owner index in issue #146
and the separate activation/revocation procedure in [R2_J.md](R2_J.md).
Before R1 activation the owner must select a record location, fill concrete URIs
and immutable versions/content hashes, and approve it separately. An owner-controlled
local record plus a retained durable export/reference is acceptable as a
procedural record only if the owner can preserve and retrieve both. The Dot PR
body, an agent-written checkbox, label or copied text cannot be that authority.
Do not store secrets in a record or its export. Unresolved location, missing
version/hash, inaccessible record or conflicting grant/revocation means **R1
inactive** and no standing publication permission.

The following is a template, deliberately **not a grant**. Replace every angle
placeholder with owner-approved concrete evidence before any activation:

```text
record_type: dot-r1-activation
status: NOT-A-GRANT-until-separately-issued-by-owner
record_id: <unique owner-issued ID>
owner: <owner identity and separate decision reference>
repository: Omnividente/omp-desktop
record_uri: <concrete owner-controlled URI outside Dot-editable PR body>
immutable_record_version: <immutable version ID>
record_sha256: <hash of retained record bytes>
durable_export_uri: <concrete retained export/reference URI>
durable_export_version_and_sha256: <immutable version and content hash>
effective_from_and_expiry_utc: <explicit start and expiry>
accepted_pilot: <separately approved pilot PR, exact accepted head and acceptance reference>
accepted_d1_cutover: <exact main SHA and cutover evidence reference>
allowed_scope: <README explanations; only the three named uiUtils functions and scoped tests>
limits: <one task/active Draft; <=5 files; <=200 changed lines; <=3 CI revisions>
publication: <own dot/* branch only; Draft=true; base=main; current GitHub plugin>
excluded_authority: <no ready/approve/merge/auto-merge/Actions manual/live/release/install>
revocation_index_uri: <concrete owner-controlled current revocation record URI>
review_checkpoint_or_expiry: <when owner must renew or review authority>
owner_activation_decision: <separate explicit owner approval bound to this version/hash>
```

Keep content hashes and the subsequent activation decision in a separate
owner-issued manifest referencing the immutable payload; do not try to embed
the hash of a file within those same hashed bytes. The template's reference
fields describe that manifest/record pair, not an implemented storage format.

For the R1 template above, the owner issues the completed record and its durable reference, then separately
approves activation bound to those immutable bytes. Dot must read the current
revocation index and verify grant identity/scope/expiry before selecting a task,
every mutation and handoff. No implementation here automatically enforces this
record or polls for revocation. Missing access or uncertain validity stops writes.

For R1 and proposal-only v1 acceptance (not each in-scope v2 task), the owner makes a separate retained record outside the Dot-editable
body with concrete record URI, immutable version/hash and durable reference,
repository/PR number, exact accepted `head_sha`, current `base_sha`, tested merge
SHA/check run IDs and attempts, platform/native limitations, explicit accept or
reject decision and permitted next operation. New head/base or dismissed/changed
acceptance requires a new decision and evidence; a previous head's checkbox is
not acceptance. Local Codex review, Windows/WebView2 or Linux native acceptance,
merge and release/install remain owner-controlled separate tasks under those
proposal-only grants. Dot does not launch them or self-approve. V2 instead uses
its one standing owner acceptance plus independent automatic per-revision
review and the protected source-only integration contract in R2_J.md; critical
source requires stronger automatic review, not a new routine owner decision.

To revoke, the owner issues a retained, versioned revocation record and updates
the owner-controlled revocation index. Include the target grant ID/version/hash,
effective UTC time, affected task/branch/PR, stop instruction and immutable durable
reference. Dot stops new task selection and mutations as soon as revocation is
known or cannot be ruled out; preserve Drafts, branch history and operation/ACK
evidence for the owner. Revocation does not unsend an accepted GitHub request,
terminate Jules, cancel Actions, delete a PR/ref or authorize recovery. Reconcile
an in-flight unknown operation by read-only evidence; no resend. Resumption needs
a new explicit owner grant, not removal of an agent checkbox.

### Shared identity is not technical isolation

The historical plan's frozen baseline recorded a shared `Omnividente` actor and
required approvals set to zero; this is not a fresh live ruleset audit. V2 must
read actual current rules and satisfy them without weakening or bypassing them.
GitHub cannot distinguish Dot, the owner and other credentials using the same
actor from commit prose. An exact-SHA owner record is a procedural control, not
technical proof of who pressed a button. Requiring one approval while retaining
the common author does not establish independent owner review.

A future separately authorized GitHub App or machine user is optional separate
work, not a prerequisite or an executor introduced here. Any future deployment
must preserve current protections and limit permissions to its accepted scope;
credentials/rulesets/App deployment remain outside standing source maintenance.
V2 uses the existing tools and verifies actual independent read-only execution
provenance; it does not claim server-enforced identity isolation or invent a
provider API. An unverifiable reviewer is a safety exception, not self-approval.

## First maintainer PR bootstrap and cutover

The D1 rules/workflow PR is a separately authorized **maintainer** change, not an
R1 task. This local-only task does not authorize its publication or a product
pilot. Do not assume proposed YAML protects the PR that introduces it.

1. Keep preparation local until the owner explicitly authorizes both source
   publication and a bootstrap strategy. On frozen baseline
   `a85e3a04b7b704d8e3bdc6dc96a2df59d7436a12`, Quality Gate completion can wake
   Proposal Review; submitted/dismissed PR reviews can wake it too; Proposal
   Review completion can wake Continue. Completion includes failure, skipped
   and cancelled, not just success. The first maintainer PR is exposed to these
   old callbacks. Blocked NEXT is neither an off switch nor proof of no effects.
2. Before publication, use a fresh, separately authorized read-only inventory of
   exact deployed workflow blobs, source/control SHAs, run IDs/attempts and all
   relevant queued/running callbacks/receivers. The owner must either authorize
   a concrete pause/drain procedure with its actual limits, or explicitly accept
   the identified old Quality Gate/review -> Review -> Continue callback effects,
   including non-success completions and possible controller/provider effects.
   Record affected exact identities and unresolved risks outside Dot-editable
   prose. A generic approval to publish or an old audit is not this decision.
   If safe limits or complete inventory cannot be established, stay source-only.
3. Do not automatically toggle `JULES_LOOP_ENABLED`, change schedules, disable
   workers, cancel/rerun Actions, resend a request, repin an executor, mutate
   queue/history or recover the stranded NEXT. Existing recovery/frontier and
   finding-resolution contracts are unchanged; do not use D1 as a recovery plan.
4. After a separately authorized owner merge, compare the actual `main` workflow
   and runtime blobs against the reviewed exact D1 revision, then refresh the
   queued/running inventory. Correlate source run/attempt/control SHAs and track
   legacy callbacks to their actual terminal/retained outcome. Frozen legitimate
   old sources do not become invalid just because `main` moved. New YAML does
   not hot-patch an old run. No blind cancellation or replay to force cutover.
5. Establish actual new-graph behavior with the separately authorized disposable
   acceptance scenarios: Dot Draft/update and CI success/failure/review cause
   ordinary CI only, no causally derived Jules Review state load/comment/dispatch;
   exact Jules lab Evidence is admitted; spoofed/stale/foreign/unknown/wrong-attempt
   sources fail closed; Review completion of every conclusion cannot wake
   Continue; existing four callbacks, including failure signals and duplicates,
   retain their checked single-effect semantics; foreign PRs cannot occupy or
   evict the Jules report slot. Local synthetic results do not prove deployment.
6. Record the exact cutover SHA, checks and correlated live evidence before the
   owner separately authorizes the one product pilot. Independent schedules and
   intentional `push(main)` -> Sync/Continue still run: global zero Jules runs is
   neither required nor a valid isolation criterion. Failed/unknown acceptance
   stops Dot publication; it does not authorize live repair. R1 remains inactive
   until accepted pilot and the separate completed activation decision.

## Intended event graph and readiness latency

This is the D1 contract after reviewed deployment and cutover, **not a statement
that this local work has been deployed**. See the
[autonomous runbook](../autonomous/RUNBOOK.md#d1-review-isolation-and-cutover).

```text
Dot Draft into main -> ordinary PR CI
  no Quality Gate -> Proposal Review edge
  no pull_request_review -> Proposal Review edge
  no Proposal Review (any conclusion) -> Continue edge

exact completed lab Evidence Gate (pull_request)
  OR schedule at minutes 17,47 UTC
  OR separately authorized owner-manual Review
    -> independent read-only metadata admission, no shared review concurrency
    -> eligible sources only: read-only state, unique persisted Jules provenance
    -> only admitted reporting job: shared review group, pinned main, fresh rechecks
    -> existing exact-identity/head/lab/CI report and race withdrawal; manual acceptance

Next Task / Sync Main / Loop Switch / Replenish -> checked Continue callbacks
push(main) -> existing Sync/Continue (intentional)
```

Admission first authenticates exact repository/head repository, workflow
path/ID/name, run/attempt/SHA, completed Evidence event and one current open
same-repository lab PR, without loading state. Unknown, stale, ambiguous,
malformed or API-denied metadata fails closed, without fallback scan. Dot-main
and Quality Gate events do not route into this path or read state. Only schedule
or authorized owner-manual review scans lab; manual authorization uses the
existing `proposal_backlog.authorize()` owner check.

**Safety deviation from the Astra metadata-only admission plan:** a genuine
Evidence run for an unknown same-repository lab PR is not Jules authority. Before
any shared report concurrency, metadata-eligible Evidence/schedule/owner-manual
admission reads the authoritative state read-only and checks unique persisted
provenance with `trusted_pull_request()`. Unknown/ambiguous callback PRs are
blocked; scans retain only persisted Jules proposals. This additional read-only
phase prevents a foreign lab PR from occupying or evicting pending Jules Review.
It writes no state and does not relax queue schema, request or provenance rules.

Admission uses trusted pinned `main`, read-only tokens, no PAT, PR code, untrusted
artifacts/cache or persisted checkout credentials. Only the admitted report gets
shared `autonomous-proposal-review` concurrency with `cancel-in-progress: false`
and PR-comment write permission. After waiting it rechecks metadata freshness
before loading state, then rechecks unique provenance against freshly read state.
It retains existing full pagination, exact head/lab/CI checks and pre/post-comment
rechecks and withdrawal. No branch/actor/label/marker substitutes for provenance.

Late Quality Gate success or submitted/dismissed owner review no longer wakes
Proposal Review immediately. Readiness is refreshed by the **next successful
scheduled Review**, after fresh CI/head/lab collection, not by the original
Evidence callback alone. Minutes 17 and 47 are cron intentions, not a 30-minute
latency guarantee; Actions queueing, disabled/failed jobs and API errors can delay
it indefinitely. If bounded operational follow-up is required, the owner may
separately authorize and invoke the existing manual Review with a bounded wait/
observation window; a timeout remains unverified, never implied readiness. No
manual dispatch is authorized by this document. This trade-off does not change
Continue's independent cadence or recover the blocked NEXT.

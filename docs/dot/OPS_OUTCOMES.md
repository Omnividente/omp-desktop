# Operational delivery outcomes: bounded continuation, not blind retry

## Activation and scope

This source change is **inactive until separately owner-activated**. It neither
rewrites source policy v3 nor enlarges the immutable OPS records in issue #146.
It covers only the existing `autonomous_recover_delivery.yml` OwnerFence and the
one distinct keyless `autonomous_sync.yml` after a verified fence. Ready/merge,
provider requests, NEXT/CONTINUE, arbitrary live-state writes and releases do not
inherit this exception. Product R1 remains inactive.

The owner-directed implementation request is not a claim that reviews, deployment
or live recovery already succeeded. Integration requires the existing two genuine
independent native executions, actual isolated tests, fresh required CI, protected
exact-head squash and verified installed main/post-merge CI. Code inspection and
author-run tests are not independent review. No new runner/service/token is needed.

After those checks, record a **new immutable operational protocol** in #146 under
the owner's bounded implementation decision, without editing the original grants.
Bind the accepted PR/head/main and installed helper Git blob, the unchanged source
grant, original OPS and runner-amendment hashes, and all six installed runner
contract blobs. Declare that only the delivery-outcome rules below supersede the
old blanket no-successor wording. Keep all other limits and prohibitions. This is
one standing operational decision, not a new owner approval for each eligible case.
Until publication/readback of that record, no new live state transition is granted.
Update the same hourly task with its exact record ID/hash; preserve its schedule.

## Outcomes and invariants

| Observed fact | State transition | May send again? |
| --- | --- | --- |
| Unknown ACK, timeout, ambiguous run or interrupted claim | Append new observation only; keep pending/lease | No; GET reconciliation only |
| Authentic native refusal **before connector invocation** | Append terminal `not_sent`; clear only its exact operational pending/lease | Not yet; one linked successor requires new verified evidence |
| Exact original run observed | Append `delivered`; keep pending for execution verification | No; dispatch acceptance is not recovery completion |
| Original retained execution artifact and actual Git readback verified | Append `verified`; clear only that operational pending/lease | No replay; fence may permit one distinct checked Sync |

The original operation, request, intent/request digests and consumed claim never
change. New records append to the same `operations` history; no second database
or replacement task exists. Source archives, budgets, grant and owner decisions
remain untouched. Recovery's logical key is repository/kind/decision; Sync's key
is repository/kind/verified fence receipt. Renaming an attempt or changing an SHA
cannot reset the attempt limit. At most **one** successor follows the original
no-send attempt, including across restarts. A second refusal may be settled, but
cannot authorize a third attempt. Repeated identical observations add no history.
A previously recorded unknown/delivered outcome cannot become automatic no-send.
A late verified original execution can settle unknown by GET without another send.

## Primary evidence and caller responsibilities

`dot_ops_outcomes.py` is a pure binding/state helper, **not a remote authenticator,
platform-risk override, dispatcher or source of permission**. `verified-active`
and evidence `status=verified` are conclusions of completed primary-source reads,
not switches to set to make validation pass. Hashes prove byte identity, not who
produced a record. The caller must retain the real observations behind each field.

For no-send retain the actual native tool name, fully expanded arguments, complete
result, transcript reference and independently observed dispatch stage. Do not
classify a transport phase from the error text alone, an absent GitHub run, an
unchanged queue, a timeout, an HTTP error or an author assertion. No provider-signed
receipt or invented call ID is required: evidence is procedural, but must really
exist. Missing or contradictory stage evidence leaves the operation unresolved.

A successor needs a fresh, hash-bound protocol/issue/revocation/source-authority
read; the acknowledged settlement CAS/readback; fresh main, exact incident state,
installed native blobs, CI and full native eligibility evidence; and retained
new evidence addressing the **actual conditions in the original refusal**. It
must use the same saved tool/transport/arguments. Unavailable original capability
is a blocker, not permission to switch to Full MCP or direct HTTP. Approval alone
is not remediation. The normal platform gate reviews the new call and can reject
it again. No general refusal bypass or retry loop is created by this protocol.

For execution, supply the actual original run/event inputs, jobs/steps, retained
artifact metadata and downloaded archive bytes. `complete_operation` validates
archive digest and members, run identity, native/upload success and exact bound
result. A fence requires the full compact PR154 proof, all before/after identities,
sole parent and current authoritative readback. Missing retention/proof, an
`already_fenced` result or green CI alone cannot permit Sync. Sync requires the
original published result, durable native publication event and checked lab/queue
readback. Caller still authenticates event provenance/full journal validation and
observes actual NEXT/CONTINUE; successful publication is not proof of loop health.

Run time is compared at the precision actually supplied: a GitHub whole-second
`created_at` covers `[created_at, created_at + 1 second)`, so preparation within
that same second is not proof that the run is historical. An earlier second or
an explicitly subsecond timestamp earlier than preparation is still rejected.
This interval check is not run identification: repository, workflow, event,
original inputs, actor, SHA, attempt and any already recorded run ID must still
match. The caller must authenticate the original event; ambiguous candidate runs
remain unresolved, not permission to select an unrelated older run.

Retained ZIPs remain bounded to **65,536 bytes**, with exact member names/counts
and stored/deflated members only. Each OwnerFence metadata member retains its
producer's **8,192-byte** bound. `sync-result.json` instead has a separate
**1,048,576-byte (1 MiB)** decompressed consumer envelope: Sync retains a variable
`refresh.proposals` list, not the compact OwnerFence report. This modest bounded
JSON allocation accommodates the reproduced 12,772-byte/100-proposal result
without importing the proof-only limit. It is not a claimed producer maximum:
the unchanged Sync/refresh producer has no count or byte cap, so some valid
producer outputs can still exceed this consumer envelope or the ZIP envelope.
Declared sizes are checked before decompression. ZIP local-header/name/overlap
validation remains, but decoded output is not taken from `ZipExtFile`, which can
truncate at an untrusted declared size. Each complete declared compressed member
is decoded separately with an output ceiling of its member limit plus one byte.
DEFLATE must reach EOF with no unused bytes or unconsumed input; stored members
must also match their complete declared size. Every decoded member must match
its size and CRC and parse as one JSON object without duplicate keys, nonfinite
values or trailing content. This applies independently to both OwnerFence members
and the Sync result; malformed fence proof cannot create a receipt permitting Sync.
Rejected archives leave pending/lease unchanged and
permit GET reconciliation only; never truncate a result, infer success or send
again. Supporting larger results would need a separately reviewed bounded
producer/consumer contract, not removal of all limits.

## API and persistence

- `reconcile_operation(state, observation, now=...)`: unknown/not_sent/delivered.
  Use this dedicated OPS API, not the source-only `dot_state.reconcile_operation`;
  the existing source helper and its separate Ready exception remain unchanged.
- `prepare_operation(state, candidate, preflight, authority, predecessor_id=..., now=...)`:
  reserve initial or sole linked successor with consumed claim **before** one send.
- `complete_operation(state, evidence, archive_bytes, now=...)`: settle genuine
  original fence/publication; never synthesize a receipt from an ACK.

Every result is only candidate state. CAS against freshly read `content.sha`, then
verify the exact acknowledged bytes. Conflict or uncertain CAS means no send.
Finding candidate bytes after lost ACK does not reissue the interrupted caller's
permission. After successful claim CAS/readback refresh authority/refs immediately
before the sole tool call. Never resend from a saved pending claim on restart.
Terminal reconciliation releases only the matching OPS lease, not an expired
source lease or another operation's lock. Live Jules writes remain solely in the
unchanged admitted native workflows; the helper writes none.

The authority envelope carries the immutable protocol plus its externally pinned
canonical digest, current issue/events/revocations, installed helper blob and
verified unchanged base delegations/source grant. Its record has version 1,
`kind=owner-ops-outcome-protocol`, the two exact `allowed_kinds`,
`maximum_successors=1`, owner decision reference/issuance, accepted main/helper,
and workflow/contract pins. Read closed/revoked history for **all** composed grants,
not just events after the newest record. A reopened issue does not revive them.
The five-minute observation bound is a freshness check, never a lease expiry or
permission to take over another invocation. Missing evidence fails closed.

## Existing incident adoption

The pending pre-protocol OPS operation may use this same schema without resetting
its original shape or digests. Adoption is metadata-only and requires the real
primary refusal plus fresh full state and newly effective authority. Historical
eligibility audit #146/comment6425687234 is not a real fence, current eligibility,
authenticated no-send classification or live settlement. No fixture in the tests
classifies the October 26 refusal. Do not run recovery during source bootstrap.

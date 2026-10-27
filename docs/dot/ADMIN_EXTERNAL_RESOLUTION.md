# Separate administrative external resolution — local candidate

This source is **not activation or authority**. No scheduler, CLI, live caller,
state writer, dispatch path, SOURCE grant, or OPS_OUTCOMES protocol is installed
or changed by it. Only a separately accepted one-off owner decision may authorize
the proposed metadata retirement. Ordinary source-maintenance authority cannot
authorize this new administrative scope.

## Preserved history and exact diff

`prepare_external_resolution(state_bytes, *, expected_dot_blob_sha,
owner_authority, external_resolution, external_archive_bytes, now)` is pure. It
checks the full raw Dot Git blob, strict JSON, and the exact original consumed
recovery attempt. It returns only candidate bytes:

1. Every existing `operations` row remains unchanged and in order.
2. One `owner-ops-external-resolution` row archives the complete original pending
   operation, matching lease, raw/full-state digests, owner decision and distinct
   external evidence. Its disposition is `administrative_closed_unknown` and
   historical delivery remains `unknown`.
3. Only that matching pending operation and OPS lease become `null`. All other
   state fields, grants, refusal history, task budgets and extension values remain.

There is no `verified`, `not_sent`, delivered-original, successor or send claim.
The external fence receipt is not an OPS completion receipt and cannot authorize
Sync. Existing logical-attempt checks continue to reject a new root operation ID
for the same decision as well as a successor without authentic no-send evidence.
The general unknown rule and normal source admission gates remain unchanged.
No original denied source candidate is retried by this implementation.

## Separate owner decision, not a broad grant

The decision binds one original operation/request/intent, original inputs, source
grant identity (preserved, not activated), matching released-lease digest, exact
before-state raw/blob/full-state digests, the external evidence record digest,
and the exact accepted administrative policy hash. No reusable send, source or
grant-mutation permission is represented. Old source/OPS grant validity does not
stand in for the separate owner's administrative decision; this API does not
assert or revive either grant's validity.

This is one-off retirement of the specifically bound original operation, not an
ongoing administrative grant. The frozen receiver's correlation key must equal
its native decision-derived value (`digest([decision_id, "dispatch"])[:32]`).
Compact fence proofs do not contain the full event or native before-digest;
receipt/event identities remain bound to the authenticated retained producer
proof, not independently reconstructed from incomplete inputs by this helper.

The caller authenticates the owner and immutable decision, issue/revocation
readback and native primary sources. Hashes and JSON assertions bind supplied
data but **do not authenticate their origin**. Tests deliberately use synthetic
owner decisions and synthetic primary observations; they are not live authority.

## External and late-path proof

External provenance stays distinct from the old request. The shared retained ZIP
parser validates actual archive bytes, digest, exact member names/counts, bounds,
CRC, full decompression/EOF, and strict artifact JSON. Original `_bundle` still
checks `_run(original)` before that parser; no rewritten original operation is
used to accept an external run.

The external historical full fence proof must bind exact native context, original
decision and expected state, before/after snapshots, sole parent, one added event,
receipt and frontier. A fresh current native ref must descend from that fence
under the accepted append-only/no-rewind trust model. Contradictions, rewind,
missing guards, unknown late code or stale observations fail closed. Current
ancestry is **not** labeled a full current journal read. No 67 MB current prefix
download is claimed or required for this metadata-only model.

Version 1 pins the reviewed original OPS `21dbb4f…`, current OPS `c05e015b…` and
actual original frozen receiver `398c6310…` with exact relevant path/blob maps.
An unreviewed future main requires new review, not automatic inheritance. Late
old recovery is constrained by its immutable expected-state input and native
single exact-parent CAS. The late frozen NEXT receiver is closed by OwnerFence
and `bound != active_intent`, not by a false claim that an ancestor controller is
always rejected due to a main-SHA mismatch.

## Replay and separate caller transaction

Exact replay verifies the current raw blob separately from the historical
before-blob and returns those same bytes without clearing a newer pending, lease
or task. It checks the immutable owner record, exact external envelope/native
records, archived original, disposition, binding and accounting-row digest.
Different evidence at the same deterministic ID is rejected. Replay cannot
produce a second external effect or new CAS permission.

No live CAS is implemented. Any future separately authorized caller must refresh
owner authority, Dot blob, native refs/lineage and pinned guard observations
immediately before an exact-blob CAS, then verify exact readback. Conflict or
unknown ACK permits only GET/readback, not a blind repeat or takeover. Dot/native
refs have no shared transaction; the accepted monotonic policy is indispensable.

## Local checks and remaining gates

Run `python3 scripts/autonomous/dot_external_resolution_test.py` and the unchanged
OPS/native/source guard regressions listed in the accompanying local report.
Native race fixtures use disposable local Git repositories only. No GitHub,
provider, session, original denied admission, live Dot state or live native queue
is touched. Whole product CI is not replaced by these focused control-plane tests.

Publication, independent exact-revision integration review, actual one-off owner
acceptance, fresh authenticated observations, and a separately authorized CAS
remain distinct gates. Source delivery alone opens none of them.

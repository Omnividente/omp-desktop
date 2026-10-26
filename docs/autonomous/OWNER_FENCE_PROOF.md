# Runner-held full-state proof for unclaimed-delivery recovery

## Status and activation

This owner-directed source proposal does not activate a new recovery policy.
The existing immutable operational delegation pins the OLD recovery-workflow
blob. Until this exact amendment is accepted, installed and covered by a new
explicit owner delegation/selection record, retain its old requirements. Never
silently edit that record or claim a changed workflow matches its old hash.
The source-only R2-J grant, Dot state and budgets are unchanged.

After that activation, the full baseline required by RUNBOOK.md is held and
verified by the existing GitHub Actions runner, not downloaded into Dot's
context. Dot need not transfer the complete queue through a size-limited tool.
This changes the location of checking, NOT the preservation invariant. The
actor is still the configured owner, the target is still one explicitly pinned
unclaimed delivery, and the existing native admission/CAS is unchanged.

## Execution and evidence

The existing `autonomous_recover_delivery.yml` keeps its exact two inputs,
main-only trigger, queue-writer concurrency, token scope and native command.
It runs three sequential commands under `set -euo pipefail`:

1. `owner_fence_proof.py before`: validate the native workflow/run/input context,
   read the exact live state commit, fetch its Git objects, read the COMPLETE
   `agent_tasks.json`, verify its Git blob SHA and byte length, reject malformed
   or duplicate-key JSON, and retain bounded baseline metadata outside checkout.
   The full immutable Git object is the baseline. No API text preview is used.
2. The UNCHANGED `recover_delivery.py`: authenticate owner admission, validate
   the full native journal and absence of executor/stage/phase/effect/completion,
   and attempt the existing exact-state, single-send OwnerFence CAS. A failed,
   uncertain or rejected result cannot run the following proof step.
3. `owner_fence_proof.py after`: fetch the acknowledged published state, require
   the original baseline as its sole parent, and compare full before/after
   contents. Every non-journal field, including timestamps and unknown future
   fields, must be unchanged. Journal metadata and the complete original event
   prefix must be unchanged; exactly one correctly bound/hash-verified OwnerFence
   is allowed. Match the native receipt, decision, owner/run/attempt/control/input
   context and verify the authoritative ref still equals the acknowledged result.

The verifier emits `OWNER_FENCE_PROOF=<JSON>` in the job log and retains
`owner-fence-proof.json` alongside the original native result artifact. The
report is at most 8192 bytes and contains commit/blob/raw SHA-256 identities,
byte counts, full-body and full-prefix hashes, event/receipt IDs and run context.
It contains no queue, requests, credentials, session data or exception text.
Hashes are computed from the full objects; health summaries and task counts do
not substitute. Git snapshots remain in the retained state history, not uploaded
as public raw queue artifacts. No new workflow, dispatch, scheduler or service
is introduced.

## Dot acceptance before a separate Sync

Dot must authenticate the actual workflow/run/attempt/event/main checkout and
original inputs through GitHub, not through a copied agent claim. Require all
native/proof/upload steps successful and the actual retained proof with exact
context, `status=verified`, `native_outcome=fenced`, `allows_sync=true`. Verify
its before/after commit/blob identities via Git metadata, the native receipt,
and current state/main/lab pins. Only then may the already-authorized, distinct
checked Sync be dispatched. This workflow never dispatches it automatically.
A successful dispatch ACK, native receipt alone, green old run, forged booleans,
short health artifact or an agent-written JSON is not that proof.

Missing/failed proof or result retention after a committed fence is unresolved
verification, NOT evidence the fence failed. Do not repeat recovery, change its
expected SHA, synthesize the report, or proceed to Sync. Read-only reconciliation
of the original run/objects remains possible; a new effect needs its existing
explicit authority. `already_fenced` is not a new proof/permission. A workflow
rerun is not a retry mechanism; the native recovery's own observation-only replay
contract is not expanded. State drift or executor races fail the native checks.

## Tests and limits of claims

`owner_fence_proof_test.py` uses disposable real Git repositories/remotes and a
synthetic queue larger than the reported 66,963,389-byte file. It tests complete
body/prefix preservation, extra/missing events, type/timestamp/unknown-field
changes, exact parent/ref/context/blob bindings, replay/unknown outcomes and
bounded non-secret output. In a complete repository checkout, an additional
integration case uses the EXISTING native JournalStore and its real Git CAS.
Synthetic envelopes in comparator tests are not live permission or receipts.
No production recovery is established by these tests. No live queue is used.

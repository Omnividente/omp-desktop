# Autonomous improvement loop - runbook

This is a **parallel** improvement track. It never releases, never bumps a
version, and never pushes to `main`. It accumulates reviewed changes on
`autonomous/lab`, and you decide - by hand, whenever you feel like it - whether
any of it is worth releasing.

## Architecture

```
main            control plane (workflows, scripts, policy) + product
  |  read-only for the loop
  v
autonomous/lab  accumulated product changes, task queue and event entry points
  ^
  |  one pull request per task, squash-merged only when every gate passes
AI worker (Jules)
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
9. **Discovery yields to real work.** Project discovery is only dispatched when
   no concrete task is queued, and a merged discovery pull request has its
   proposals imported into the queue by `import_discovery_tasks.py`. Only a newly
   matched completion imports proposals, so repeated sweeps cannot import the
   next ten findings from an old PR. Completion and import are staged together;
   malformed JSON fails without committing either. Fix its PR body and rerun
   Autonomous Next Task instead of losing the backlog.
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

## One-time owner setup

1. Install the **Jules GitHub app** on `Omnividente/omp-desktop` and allow it to
   open pull requests.
2. Add repository secrets: `JULES_API_KEY`, optionally `JULES_API_KEY_BACKUP`
   (used only when the primary key fails), and `PAT` - a token with the `repo`
   **and `workflow`** scopes. The loop switch needs it to write the
   `JULES_LOOP_ENABLED` Actions variable and to publish the entry-point
   workflows onto `autonomous/lab`; `GITHUB_TOKEN` cannot write
   `.github/workflows/**`.
3. Merge the control plane into `main`. Until these workflow files are on the
   default branch, `workflow_run`-triggered automerge does not exist yet.
4. **Protect `autonomous/lab`** and require these check runs _by name_:
   `Checks (ubuntu-latest)`, `Checks (windows-latest)` - both produced by the
   `Quality Gate` workflow, and the required-checks list takes check-run names,
   not workflow names - plus `Autonomous Evidence Gate`. The same names are in
   `merge_gate.required_check_names`, which is what automerge reads. Without
   server-side protection the guards are enforced only by the workflow that
   performs the merge; with it, the rules hold even if a workflow is edited.
5. Run **Autonomous Loop Switch** with `loop_enabled = true`. It first disables
   new dispatches, then creates/seeds the branch and publishes entry points,
   and only then enables the variable. A publication failure leaves the loop
   off and preserves the existing queue. With preparation disabled, every entry
   point must already match `main` or enabling fails.

Until step 5 the loop is completely inert: every scheduled job is gated on
`vars.JULES_LOOP_ENABLED == 'true'`.

## Day-to-day

- **Autonomous Monitor** (every 3h, or on demand) reports queue lifecycle, open
  pull requests, how far `autonomous/lab` is ahead of `main`, and warns when
  pull requests merge but no task is marked done.
- **Autonomous Next Task** (every 30 min) dispatches at most one task while no
  autonomous pull request is open.
- **Autonomous Replenish** (every 6h) refills the queue from real eslint and tsc
  diagnostics only. No speculative work is ever queued.

### Accepting something the loop cannot merge alone

A pull request labelled `human-review` is waiting for you. Review it, and if you
want it in, merge it yourself. Do not remove the label to make the robot merge
it - the label is a stop sign, not a switch.

### Deciding on a release

Run **Autonomous Release Review**. It pins `autonomous/lab` to one commit,
dispatches the existing Quality Gate and requires that run to have executed on
exactly that commit, then reports the diff, the merged pull requests and the
verification result for that same commit. If the branch moves mid-review, the
review fails instead of pairing a green run with a different tree. The downloaded
report itself says **NOT VERIFIED** unless the reviewed SHA has a successful
verification. Git/resolve failures produce a failure artifact too; upload runs
even when report generation fails after checkout.

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
- **A merge by the loop does not trigger the loop.** Events caused by
  `GITHUB_TOKEN` start no further workflow run, so a merged pull request is
  completed directly after automerge; the scheduled API sweep is the recovery
  path if that transaction did not finish, within 30 minutes.
- **A fallback API key is only used when the primary key fails**, not for load
  balancing.
- **Merged discovery proposals are capped** at 10 new tasks per pull request.

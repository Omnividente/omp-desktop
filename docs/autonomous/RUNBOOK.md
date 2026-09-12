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
autonomous/lab  accumulated improvements; carries only agent_tasks.json
  ^
  |  one pull request per task, squash-merged only when every gate passes
AI worker (Jules)
```

Every loop workflow performs **two checkouts**:

| Path       | Ref              | Purpose                                    |
| ---------- | ---------------- | ------------------------------------------ |
| `control/` | `main`           | scripts, `autonomous-project.json`, prompts |
| `lab/`     | `autonomous/lab` | product tree and `agent_tasks.json`        |

Consequences worth knowing:

- The loop cannot weaken its own rules. A pull request that edits
  `scripts/autonomous/**` or `.github/workflows/**` can never be merged by the
  loop, and even if it were, the loop would keep reading the version on `main`.
- A fresh `autonomous/lab` does **not** need the control plane copied into it.
  The only file it must carry is `agent_tasks.json`, which **Autonomous Loop
  Switch** seeds for you (additively - an existing queue is never overwritten).

## Invariants enforced by code

1. **One revision, end to end.** `autonomous_automerge.yml` acts on the commit
   the Quality Gate actually verified (`CI_SHA`). It aborts if the pull request
   head has moved, derives the changed-file list from that commit, evaluates
   scope for that commit, and merges with
   `--match-head-commit "${CI_SHA}"`. The CI-verified SHA, the reviewed SHA and
   the merged SHA are the same commit or nothing merges.
2. **A fix must prove it fixes something.** `autonomous_evidence_gate.yml` runs
   the touched tests at the merge base with the source change reverted (it must
   **fail**) and again with the change applied (it must **pass**). Automerge
   reads that check run by name and refuses to merge without it. Changes it
   cannot prove offline - Rust, config, anything outside the TypeScript test
   runner - are failed on purpose and routed to you.
3. **Tasks have a lifecycle.** `todo -> in_progress -> done | blocked`, owned by
   `task_lifecycle.py`. A merged or closed pull request closes its task; a
   session that finished without changes closes it as `no_change`; an abandoned
   session is released after `lifecycle.stale_in_progress_hours`; a task that
   burns `lifecycle.max_attempts` becomes `blocked` instead of cycling forever.
   The worker cannot edit the queue - only the automation writes it.
4. **Discovery yields to real work.** Project discovery is only dispatched when
   no concrete task is queued, and a merged discovery pull request has its
   proposals imported into the queue by `import_discovery_tasks.py`.
5. **Scope is checked, not trusted.** `check_change_scope.py` rejects anything
   outside `product.editable_globs` and anything in `product.excluded`.
6. **Sensitive paths need you.** Files in `product.manual_review_paths` (the
   client updater and its tests) may be proposed by the loop but never merged
   unattended: the pull request is labelled `human-review` and stops there.
7. **Nothing releases.** `verify_policy.py` fails if release automation is ever
   re-enabled in policy, and Autonomous Control CI greps every loop workflow for
   release verbs, tags, version bumps and writes to `main`.

## One-time owner setup

1. Install the **Jules GitHub app** on `Omnividente/omp-desktop` and allow it to
   open pull requests.
2. Add repository secrets: `JULES_API_KEY`, optionally `JULES_API_KEY_BACKUP`
   (used only when the primary key fails), and `PAT` (a token with `repo` scope,
   needed only by the loop switch to write the Actions variable).
3. Merge the control plane into `main`. Until these workflow files are on the
   default branch, `workflow_run`-triggered automerge does not exist yet.
4. **Protect `autonomous/lab`** and require the checks `Quality Gate` and
   `Autonomous Evidence Gate`. Without server-side protection the guards are
   enforced only by the workflow that performs the merge; with it, the rules hold
   even if a workflow is edited.
5. Run **Autonomous Loop Switch** with `loop_enabled = true`. It creates and
   seeds `autonomous/lab` if needed.

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
review fails instead of pairing a green run with a different tree.

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
- **Very large pull requests.** The compare API returns at most 300 files; a
  larger diff is treated as out of scope rather than partially checked.
- **A fallback API key is only used when the primary key fails**, not for load
  balancing.
- **Merged discovery proposals are capped** at 10 new tasks per pull request.

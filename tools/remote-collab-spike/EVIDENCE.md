# Preparation evidence: Remote Collab spike

This record distinguishes local observations from the checks that a pull request
must run on its exact head. A test recipe or a successful source review is not a
passing native integration test.

## Revisions and scope

- Prepared on 2026-11-08 against Desktop `main`
  `ce1a497fb7988a7c4ed305ef2890436342c9f7ad`.
- Upstream source contract:
  [`can1357/oh-my-pi@cb4801a7d6db666946a1b65fce5cdf50d2947b96`](https://github.com/can1357/oh-my-pi/tree/cb4801a7d6db666946a1b65fce5cdf50d2947b96).
- Official runtime asset:
  [`v18.18.1/omp-linux-x64`](https://github.com/can1357/oh-my-pi/releases/download/v18.18.1/omp-linux-x64).
  Its downloaded SHA-256 matched the release asset digest:
  `2a75e16550676783b3bc8be0e06513478dd5881efc647954642ab30db8f9be06`.
- Product provenance remains the owner's [Discussion #104](https://github.com/Omnividente/omp-desktop/discussions/104)
  and earlier [issue #103](https://github.com/Omnividente/omp-desktop/issues/103).
  This does not change their status or mark a proposal delivered.

The adapter is a developer-only consumer of existing registry `snapshot` and
`link`. No Desktop production wiring, upstream changes, model prompts, user
session access, pairing service, Telegram configuration or deployment is part of
this slice.

## Observed in the preparation environment

| Check | Observation | What it establishes |
| --- | --- | --- |
| Node | `24.22.1` | Available interpreter; hosted matrix uses Node 22. |
| Python | `3.12.14` | Available optional smoke interpreter. |
| Four JavaScript syntax checks | PASS | Files parse; does not establish IPC behaviour. |
| Python AST parse | PASS | Harness parses; does not establish runtime compatibility. |
| Capability grammar, filesystem and CLI subset | 6/6 PASS | Complete generated-link validation and rejection of nested-fragment access confusion; explicit-directory handling, malformed metadata preservation, POSIX symlink/permission rejection, CLI validation and unavailable mutations. |
| Full 23-case suite | 6 PASS, 17 fixture setup failures | Every transport fixture failed with `fixture_setup_EPERM` before its protocol assertions. This is not a passing IPC suite. |
| Official binary `--version` in a disposable filesystem/PID sandbox | `omp/18.18.1` | Binary identity and basic execution only. No session or provider was started. |
| Full isolated runtime harness | `sandbox_launch_failed` | The environment denies socket creation; bubblewrap failed to create a `NETLINK_ROUTE` socket for its network namespace. The worker did not run. |

The socket restriction was not bypassed. The suite has no mock fallback or silent
skip for unavailable transport. Only the two specifically POSIX ownership/link
cases are intentionally skipped on Windows.

Subset command:

```sh
node --test \
  --test-name-pattern='^capability grammar|^filesystem|^CLI requires|^unsupported live' \
  tools/remote-collab-spike/registry-client.test.mjs
```

## Hosted evidence to inspect on the exact PR head

The existing **Quality Gate** runs `npm run test:remote-collab` on Ubuntu and
Windows. The fixtures use separate Node processes and real Unix sockets / named
pipes. These checks cover the consumer protocol, including a rotation between
snapshot and link, mutable caller state, bounded transport and safe CLI output.
The Windows run does not prove Windows ACL protection or a real Windows OMP host.

The path-filtered **Remote Collab runtime smoke** workflow uses the pinned official
Linux asset above, Python 3.12, Node 22 and bubblewrap. It runs a new synthetic OMP
session for each access level, with a private temporary home and no external
network in the worker. Its ephemeral loopback relay and encrypted guest check the
real registry/link boundary, stale generation, view/control admission, and
withdrawal of the test room through its own TUI.

The harness never prints the OMP terminal, registry token or capability URL. It
sends no model prompt. Test-only `/collab stop` is not an external lifecycle API,
and a successful smoke run must not be reported as Desktop live stop/revoke support.

For hosted results, use the pull request's Checks tab and each run's **head SHA**.
This preparation record deliberately makes no claim about a run that had not yet
executed. A later successful run supersedes the local environment limitation for
its tested platform and revision only.

## Review and unresolved product work

Independent source review of the v2 specification identified and tightened the
issued-grant obligation after manual Collab changes, lifecycle acknowledgement
revision fences, and notification content crossing the Collab encryption boundary.
Separate independent review of the code and runtime harness corrected ambiguous
fragment parsing, mutable caller state, startup readiness and the exact registry
metadata withdrawal check. A reviewer compared generated links and the rejected
counterexamples with the actual pinned upstream formatter/parser. This source
and pure-function evidence does not substitute for the hosted IPC/runtime runs.

Live start/stop/access rotation remain unavailable through the pinned registry.
No result here proves verified Desktop ownership, persistent policy, end-to-end
revocation from Desktop, public relay deployment, prompt acknowledgements,
Telegram login, notifications or the remote browser UI. Those are explicit later
milestones in [the v2 specification](../../docs/REMOTE_V2.md).

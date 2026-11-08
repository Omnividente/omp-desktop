# OMP Remote: local Collab compatibility spike

This developer-only prototype consumes OMP's existing local Collab registry. It
does not install a Desktop feature, modify OMP, enable sharing, connect to a relay,
start a provider, open a browser, or change a running session.

The purpose is to prove a narrow integration boundary before implementing
[Discussion #104](https://github.com/Omnividente/omp-desktop/discussions/104): an
explicitly selected session can yield a capability only for its approved room
generation and access level. A stale request must never silently open a successor.

## Contract and scope

The implementation follows
[registry v1 at upstream `cb4801a7`](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/coding-agent/src/collab/registry.ts).
It uses the documented authenticated `snapshot` and `link` JSON-line requests
over a local Unix-domain socket or Windows named pipe. No alternative session
transport or server is introduced.

Supported:

- Read discovery metadata from an **explicit absolute registry directory**.
- Inspect live host identity, generation, access and activity state.
- Require metadata and snapshot PID/instance identity to agree.
- Match the caller's approved session ID and generation before requesting a link.
- Send that exact generation in the `link` request; never refresh it implicitly.
- Validate a returned link's encoded view/control capability in memory.
- Report incomplete discovery and fixed failure codes without raw host errors.

**Live `start`, `stop`, and `set-access` are unavailable in the upstream registry
contract.** These commands fail with `runtime_control_unavailable`; there is no
simulated revocation, restart, or downgrade. `capabilities` in probe output
describes this adapter's supported operations, not a claim that an uninspected
OMP installation implements them.

The caller must already know which session it is allowed to open. PID correlation
and a valid local capability alone do not prove Desktop ownership or remote-user
authorization. Pairing, policy storage, verified handoff, notifications, prompt
delivery acknowledgements, room revocation and the remote UI remain separate
integration work.

## Requirements and tests

Use Node.js 22.13+ or 24+. No npm installation or third-party package is required.

From the repository root:

```sh
npm run test:remote-collab
node tools/remote-collab-spike/probe.mjs --help
```

The npm script runs `node --test tools/remote-collab-spike/registry-client.test.mjs`;
the direct command also works without installing the application's dependencies.

The suite starts separate synthetic Node processes using actual local IPC. Each
fixture creates its own temporary directory, metadata and socket/pipe and removes
only those resources at teardown. Tokens and room keys are generated afresh; no
real credentials, session files or providers are used. Fixture control messages
use Node's private parent/child IPC channel and are not an OMP API.

Tests cover access levels, stale dashboard state, rotation between requests,
session/instance/PID mismatch, authentication, ambiguous entries, unknown activity,
timeouts and bounded/malformed responses, no pruning, and sanitised CLI output.
Pure parser tests and synthetic IPC regressions reject nested fragments that
could otherwise disguise a control secret as a view capability.
POSIX ownership/permission/symlink tests are explicitly skipped on Windows.
The named-pipe code path still requires an actual Windows run before it is claimed
verified. A failed socket setup such as `fixture_setup_EPERM` is an environment
failure, not a passing transport test; the suite does not silently skip it.

Synthetic registry tests establish the consumer protocol boundary. They do not
prove a real OMP process, relay, encrypted guest, UI, or live revocation. Record
actual runtime checks and their exact revisions separately.

## Optional real-runtime smoke

The separate [runtime smoke workflow](../../.github/workflows/remote-collab-smoke.yml)
runs on changes to this directory or its workflow. It complements the synthetic
registry suite in the normal Quality Gate. See [EVIDENCE.md](EVIDENCE.md) for the
recorded execution status; the presence of a harness is not proof of a successful
real-runtime run.

To run it manually, use Linux (the CI job uses Ubuntu), `bubblewrap`, Node.js,
Python 3.12, `websockets==16.0` and `cryptography==50.0.0`. Prepare the official
OMP 18.18.1 Linux x64 executable yourself and give its absolute path explicitly.
The harness verifies the expected digest before launching it; it does not search
for a user's OMP installation or download a binary.

```sh
python3 tools/remote-collab-spike/runtime-smoke.py \
  --omp /absolute/path/to/omp-18.18.1-linux-x64 \
  --expected-sha256 2a75e16550676783b3bc8be0e06513478dd5881efc647954642ab30db8f9be06
```

The disposable process runs inside a private filesystem, PID and network
namespace with a synthetic home and empty working directory. A synthetic
loopback relay and encrypted guest exercise the real runtime without provider
inference or a public relay. The harness uses the TUI command `/collab stop`
only inside that disposable process to inspect runtime behaviour. This is a
test-only input, not a production Desktop IPC operation or a new `stop` API.
Unavailable namespaces or sockets cause a failure; there is no fallback to a
user session or unrestricted networking. This Linux harness does not establish
Windows runtime compatibility.

## Inspect an explicitly prepared test registry

Use a dedicated synthetic OMP configuration root and disposable session when
manually testing. The tool intentionally has **no default home/config lookup**.
Do not point the repository test suite at real user sessions.

```sh
node tools/remote-collab-spike/probe.mjs inspect \
  --registry-dir /absolute/isolated-omp/run/collab-hosts
```

On Windows, pass the equivalent absolute directory in a private test
configuration root. Native ACL protection of that root is the operator's
responsibility; Node's POSIX ownership checks do not establish Windows ACL safety.

Successful output is one JSON object. It contains safe host IDs, PID, generation,
access, relay/input/activity state, and an SHA-256 fingerprint of each session ID.
It excludes raw session IDs, titles, working directories, model fields, endpoints,
bearer tokens and links. The programmatic API retains session IDs only for local
matching. A fingerprint is an identifier, not encryption or an authorization
credential; predictable session IDs can still be guessed.

`registryState: "missing"` is distinct from an empty existing registry. Malformed
or unavailable entries are counted in `skipped`; they are never deleted.

## Check one approved capability

Take the expected session ID from the dedicated test session you started. Take
its instance ID and generation from the inspected host. `inspect` deliberately
does not reveal the raw session ID, and this check does not infer it from titles.

```sh
node tools/remote-collab-spike/probe.mjs check-link \
  --registry-dir /absolute/isolated-omp/run/collab-hosts \
  --instance EXPECTED_INSTANCE_ID \
  --session EXPECTED_SESSION_ID \
  --generation 1 \
  --access view
```

Use `--access control` only for an intentionally control-enabled synthetic host.
The check confirms that the host supplies a structurally valid capability for the
requested access. It discards the capability after checking it: success does not
mean a browser joined, a prompt executed, or a connected guest was revoked.

The limited link validator follows the generated browser-wrapper forms in
[upstream's pinned link formatter/parser](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/coding-agent/src/collab/protocol.ts):
an HTTPS URL (HTTP only for loopback), with exactly one complete inner link in
its fragment. Accepted inner links are a bare `room.key`, a custom
`relay-host[:port]/r/room.key` (including IPv6), an explicit `wss://` equivalent,
or a loopback-only `ws://` equivalent. A separate web UI host and path are allowed.
It verifies a canonical 16-byte room ID and a 32-byte read key or 48-byte
read/write secret.

Validation is anchored to the complete inner link: extra path segments, query
strings, user information and nested raw or encoded fragments are refused.
Percent escapes inside the inner link and encoded `#` (`%23`) anywhere in the
outer URL are intentionally unsupported, including an encoded `#` in an otherwise
valid custom viewer path. Upstream decodes that escape before parsing the whole
URL, which can change the effective room or access. Ordinary viewer-path escapes
such as `%20` remain supported. General legacy or other hand-written join-link
formats fail closed.

No CLI option prints a link or writes it to clipboard, disk, logs or a browser.
The tool itself still receives a live bearer capability in memory. JavaScript
does not provide a guarantee that all copies of a string are immediately erased.

## Programmatic consumer

```js
import { inspectRegistry, withCapability } from "./registry-client.mjs"

const inspection = await inspectRegistry({ registryDir, timeoutMs: 1500 })

// expected must come from the caller's approved session binding, not from
// automatically choosing whichever session is current when the request arrives.
const result = await withCapability(
  { registryDir, expected: { instanceId, sessionId, generation }, access: "view" },
  async (url) => {
    await trustedInMemoryConsumer(url)
  },
)
```

The callback is trusted code and must not log, retain or persist the secret. Its
return value is discarded. The function returns only checked identity/access
metadata; callback failures become `consumer_failed` without retaining the raw
exception. Host errors and invalid response bodies are likewise not exposed.

## Bounds and failure results

| Boundary | Limit / behaviour |
| --- | --- |
| Registry | Explicit absolute path; no recursion, no writes or pruning |
| POSIX registry/metadata | Current-user ownership; private permission bits; symlinks refused |
| POSIX endpoint | Local socket owned by the current user; symlinks refused |
| Windows endpoint | Local `\\.\pipe\` namespace only |
| Directory entries | At most 256 entries, including socket/lock/non-JSON files |
| Concurrent snapshot requests | At most 8 |
| Metadata/request | 4 KiB each |
| Response | One line, at most 64 KiB |
| Request deadline | 1500 ms by default; `--timeout-ms` accepts 10–10000 ms |
| Session identity for link | Nonempty and shorter than upstream's 1024-character truncation bound |
| Unknown activity | Missing `busy` becomes `null`, never idle |
| Duplicate live instance | `ambiguous_host`; no guess or automatic retry |
| Stale session/generation | `session_mismatch` / `stale_generation`; no successor link released |

Exit status: `0` for successful inspection/check, `1` for a probe failure, `2` for
invalid arguments, `3` for unsupported live mutation. Errors are fixed-code JSON
on stderr. Discovery can succeed with skipped entries, which remain explicit in
the output; an empty result alone is not proof that every host was reachable.

This spike does not assert that a room secret can be revoked through this API.
Current Collab access is a bearer capability: refusing a later link request does
not revoke an earlier one, and providing a view link does not revoke an existing
control link.

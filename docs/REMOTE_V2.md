# OMP Desktop Remote — specification v2

Status: proposed design and local compatibility spike. This document does not
declare Remote available in OMP Desktop or authorize a deployment.

Origin: the owner's [issue #103](https://github.com/Omnividente/omp-desktop/issues/103)
and [Discussion #104](https://github.com/Omnividente/omp-desktop/discussions/104).
Issue #103 remains closed as `not_planned`; this document does not reopen it or
replace that historical decision. The owner subsequently requested this revised
specification and isolated compatibility prototype. That task is not acceptance
of the complete product or authorization to expose existing sessions. Revision 2
retains the original authorship and local execution model while making the
access, lifecycle, delivery, and acceptance contracts explicit.

## 1. Intended outcome

An owner selects individual live OMP sessions on a computer, leaves the desk,
receives a useful notification, and continues the same conversation from a
phone or browser. OMP, its tools, provider access, files, and execution remain
on the original computer.

The first product release serves one owner with multiple Desktop installations
and individually identifiable remote clients. One responsive web application
works in a browser and a Telegram Mini App. Telegram is the initial identity
provider and notification channel; it is not the primary key of the domain
model. Notifications and session access are independently configurable.

The initial remote actions are reading a shared session, prompting, interrupting,
viewing supported subagents, and answering supported host dialogs. Their actual
availability comes from the installed OMP capability set. Model changes, new
process launches, configuration administration, arbitrary file browsing, shared
multi-user workspaces, cloud transcript history, and a daemon that outlives
Desktop are outside this release.

Control means the ability to instruct the local agent using that session's
tools and approvals. Omitting a shell button does not remove the agent's ability
to execute commands or change files. View includes the history and tool results
that Collab replicates; it is not a redacted summary of the session.

## 2. Evidence baseline and current boundaries

The design review used Desktop commit
[`ce1a497fb7988a7c4ed305ef2890436342c9f7ad`](https://github.com/Omnividente/omp-desktop/commit/ce1a497fb7988a7c4ed305ef2890436342c9f7ad)
and OMP commit
[`cb4801a7d6db666946a1b65fce5cdf50d2947b96`](https://github.com/can1357/oh-my-pi/commit/cb4801a7d6db666946a1b65fce5cdf50d2947b96)
on 2026-11-08. Source inspection is not native verification of an installed
runtime, Telegram webview, or production relay.

| Existing capability | Consequence for this design |
| --- | --- |
| Collab exposes local `snapshot` and generation-bound `link` operations; CLI exposes `list` and `link`. | Discovery and exact-target opening can be prototyped without a new session protocol. |
| The in-process Collab controller supports live start and stop, but the registry has no external start, stop, access-policy, or rotation operation. | Live Desktop lifecycle control is an upstream integration dependency. A successful link probe does not satisfy it. |
| `/collab view` reuses an existing control room. | Obtaining a view link does not revoke previously issued control links. A real downgrade requires retiring that room. |
| Explicit Collab stop does not change the saved auto-start policy. | Persistent Off requires both policy enforcement and current-room teardown. |
| Normal prompt frames have no request ID or correlated admission acknowledgement. | An uncertain send cannot be automatically replayed with an exactly-once guarantee. |
| Desktop already passes runtime configuration overlays and can restart an exact `--resume` target. | Reuse launch plumbing, but do not treat process restart as a live settings change. |
| Desktop's completed-answer version is UI state and its answer panel reads the selected idle tab. | Notifications need a backend event source and durable deduplication. |
| Desktop shuts down its managed terminals on application exit. | Remote availability requires the computer, Desktop, and the relevant OMP process to remain running. |
| The production Collab relay is not distributed as a supported self-hosted release. | Hosting the Remote control service alone does not produce a completely self-hosted system. |

These are compatibility constraints, not authorization to patch the user's OMP
installation, expose existing sessions, or restart their work. Upstream proposals
are background references; the installed, probed protocol is authoritative.

### Implemented slice accompanying this specification

`tools/remote-collab-spike/` is an isolated Node.js standard-library consumer of
OMP's existing private authenticated registry IPC. It is a discovery/link slice
of Phase 0, not the Desktop Remote Manager or an implementation of the complete
access lifecycle described below.

- `inspect` reads only an explicitly selected test registry, with bounded
  requests and sanitized output; it does not discover the user's default root.
- `check-link` requires a pinned instance, session, generation, and access. It
  obtains the capability over real local IPC and keeps the URL in process memory;
  its CLI reports only a sanitized verification result.
- Start, stop, rotation, and policy changes remain unsupported by the adapter
  and probe. They do not inject slash commands, restart sessions, or simulate
  success for operations absent from the upstream interface.
- Cross-process synthetic fixtures use Unix sockets or Windows named pipes.
  Their results establish consumer behavior at that boundary, not successful
  lifecycle management of a real OMP session or native verification on a platform
  where the suite has not run.

The separate optional Linux `runtime-smoke.py` harness uses `bwrap` to run only
its own synthetic OMP session and loopback test relay. It may drive that test
session's TUI, including `/collab stop`; this is not production lifecycle IPC or
permission to inject commands into a user's session. Any execution against an
official OMP binary must report its exact version, isolation, and results. This
document makes no claim that the smoke test succeeded.

The prototype adds no Desktop settings, frontend controls, persistent policy,
Telegram login, notification service, or production network listener. Its runner
and tests are documented alongside the code.

## 3. Component responsibilities

| Component | Responsibility |
| --- | --- |
| Local OMP | Session execution, tools, local approvals, Collab replication, and guest permission enforcement. |
| Desktop Remote Manager | Local allowlist, runtime ownership and identity, access policy, lifecycle coordination, event normalization, and final authorization of each open request. |
| Remote control service | Account login, device/client records, presence, authenticated request routing, and notification delivery. |
| Browser / Mini App | One responsive interface, session presentation through Collab, explicit delivery state, and client-local handling of capabilities. |
| Telegram bot | Pairing entry point, independently authorized notifications, and links that identify a target without granting access. |

Desktop initiates its authenticated control connection outbound. The control
service receives only approved metadata and does not proxy transcript traffic,
run tools, hold provider credentials, or act as an alternative OMP runtime.
Collab owns the session data path. A new control connection must not implicitly
publish every local Collab host.

## 4. Identity and ownership

Keep these identities separate:

- `Owner`: an opaque internal owner ID.
- `ExternalIdentity`: a verified login identity, including OIDC issuer/subject
  and, when available, a verified Telegram user ID.
- `DesktopDevice`: a paired Desktop installation with its own credential and
  display alias.
- `RemoteClient`: a particular registered browser or phone, with independent
  session revocation and last-seen state.
- `PublishedSession`: an opaque remote ID pointing to an explicitly approved
  logical local session. Its local paths never become routing parameters.
- `SessionPolicy`: desired access, notification preferences, continuation rule,
  remote alias, and a monotonically changing policy revision.

The local binding for a live room includes the Desktop device, current local
session identity, a Desktop-owned runtime, Collab `instanceId`, and room
`generation`. PID is a correlation hint, not sufficient authorization: processes
can restart, PIDs can be reused, and executable wrappers can introduce another
process. Titles and working-directory similarity must never select a substitute
session when identity is ambiguous.

An imported session, copied session, unrelated local OMP process, or guest replica
is not automatically authorized. A missing or ambiguous binding fails closed
without affecting the underlying local work.

## 5. Desired policy and observed state

`desiredAccess` is `off | view | control`. It records the owner's intent.
The observed room state is separate: `inactive | starting | ready | disconnected
| revoking | unknown | unsupported | conflict | error`. `observedAccess` and the
room identity are present only when established by a current observation.

The UI may show **OMP Remote off** only after outstanding Remote grants are
invalidated and managed auto-start policy is disabled. A timed-out request, an empty
listing, or a disconnected control channel is not confirmation of revocation.
Unknown `busy` is not idle; unknown room state is not stopped.

For managed launches and relaunches, Desktop supplies an explicit session
Collab policy, including `off`, with verified configuration precedence. Merely
omitting an overlay can inherit global `collab.autoStart`. Remote must not write
the user's global OMP configuration. All managed launch paths, including an
existing provider-pin restart path, must apply the same policy.

Rooms never managed by Remote are an independent Collab channel, with separate
status in the UI; **OMP Remote off** is not a universal sharing-off indicator.
Once Remote has issued a capability for a generation, its revocation obligation
persists until that grant is confirmed ineffective. Later manual OMP actions,
reclassification as independent sharing, or a conflict state must not erase
issued-grant records or that obligation. Reconcile manual changes to managed
rooms without silently adopting unrelated rooms or claiming revocation from
disappearance alone. Keep grant identity and status, not the capability secret.

### Access operation contract

| Operation | Required result |
| --- | --- |
| Enable View / Control | Establish the requested room for the exact permitted session; report ready only after the installed runtime confirms the binding and effective access. |
| Control to View | Retire the old room and its control capability; publish a new view room. Returning `link --view` is insufficient. |
| Off | Deny new opens, invalidate pending and still-effective issued grants, disable managed automatic rehosting, and confirm teardown of the affected room generations. |
| Revoke a client | Immediately deny that client's new control-service requests; retire every still-effective room capability issued to it, then reissue access to remaining clients as needed. |
| Disconnect all | Apply the same local teardown contract to all Remote-managed sessions. |
| Interrupt agent | A separate Collab action, available only to an authorized writer; it is not implied by revoking access. |

Current room secrets are shared bearer capabilities. Per-client revocation may
therefore rotate the whole room and disconnect other clients. Do not promise
selective revocation that the installed protocol cannot enforce. Already received
content cannot be recalled, and closing a room does not undo already admitted
agent work.

Increment the policy revision before revocation or downgrade starts, and the
client authorization epoch on client/session revocation. Lifecycle requests and
their acknowledgements bind `operationId`, runtime/session/generation, policy
revision, and the authenticated client's authorization epoch. Only a matching,
still-current acknowledgement can advance observed state. A late start result
after Off cannot restore ready: reconcile any created room under the newer
policy. A late stop acknowledgement for an old generation cannot mark its
successor Off. Reject stale open results before release; browsers also discard
superseded open responses. When Desktop is unreachable, account/session
revocation is separate from room revocation, which remains pending locally.

### Live changes and restart compatibility

The preferred lifecycle boundary is a small authenticated local interface to
OMP's existing Collab controller. Its required semantics are start, stop,
effective access-policy change, exact session/generation preconditions, and
observed completion. This is a required future contract, not an API currently
available in the reviewed registry.

A session enabled at launch may use `--config`. An already running session must
not be silently restarted to enable Remote, downgrade access, or satisfy a
failed probe. Exact `--resume` does not preserve arbitrary process memory or
prove that background/scheduled work is quiescent. A compatibility restart, if
offered later, is an explicit separate operation with the existing lifecycle
guards and a visible failure state when stop succeeds but relaunch fails.

Immediate Off must not depend on waiting for the agent to become idle. If the
installed runtime cannot safely stop sharing without terminating the session,
that capability is unsupported for the integrated release; do not disguise it
as successful revocation.

## 6. Session transitions and opening a room

| Transition | Policy rule |
| --- | --- |
| Restart of the same verified session | Preserve policy, establish a new runtime/room binding, and obtain a new capability. |
| Verified handoff to the approved logical continuation | Transfer policy only under an explicit continuation rule; obtain a fresh binding and capability. |
| `/resume` to another session, a new independent session, fork/copy/import | Off by default; no authority inheritance merely because the terminal or PID stayed the same. |
| Unclassified transition | Withdraw remote publication and require a new verified binding. |
| Room replacement for the same verified session | Refresh metadata and reauthorize the open request against the current policy. |

Desktop's current transfer of title/provider preferences is not proof of a
handoff. A parent-session path is a useful input but is not the whole
authorization contract. Until the transition origin can be established reliably,
cross-session transfer stays disabled rather than guessing from similar titles
or paths.

An open request identifies `remoteSessionId`, the expected session binding,
`instanceId`, `generation`, requested access, client identity and authorization
epoch, policy revision, request ID, and expiry. The browser supplies no arbitrary
command or local path.

Desktop must:

1. Validate the owner/client, authorization epoch, expiry, replay state, and policy revision.
2. Resolve the opaque target to its local approved session and verify runtime
   ownership, current session identity, and room generation.
3. Request only the permitted capability from that exact generation.
4. Check the returned identity/access and revalidate the local grant before
   releasing the result. Discard secret-bearing results on a mismatch.
5. Return a bounded, structured outcome. Do not expose CLI stderr, paths, or
   capability material in a failure response.

The existing CLI `link` operation performs a fresh internal listing; its
generation check covers its own list-to-link interval, not an earlier dashboard
card. An adapter must use the documented generation-bound local IPC, or reject
CLI JSON results whose returned generation differs from the expected binding.
On a stale target, refresh metadata first. Never silently open a successor
session simply because it shares an `instanceId`.

## 7. Prompt delivery and mobile reconnect

The current Collab prompt protocol provides no correlated admission ACK or
host-side request deduplication. The Remote control service cannot add that
guarantee to traffic it does not carry.

The first compatible UI must preserve the user's draft until the outcome is
understood, expose disconnection and unknown delivery, and never automatically
resubmit a prompt with an unknown outcome. Transcript resynchronization can
provide evidence that a message exists, but matching text alone is not reliable
correlation. Do not label a local `WebSocket.send()` result as host acceptance.

For reliable automatic retry, a future upstream contract needs a stable client
request ID, a correlated admission result, and deduplication scoped to the
session and its defined lifetime. Document what happens across process restart;
an in-memory dedupe map cannot promise persistence across it.

Host UI responses are a different operation: they already have a request ID
and single-settlement behavior. `ui-request-end` proves that a question ended,
not that this client's value was the accepted answer. A local user, another
client, or cancellation may have settled it first. Old question IDs must never
be replayed into a replacement room.

Test network loss before send, after send but before a durable entry is observed,
during key sealing, during a host dialog, and when a Mini App backgrounds and
resumes. Reconnection must complete authorization and state synchronization
before it enables new mutations. Queue ordering and overflow require observable
failure behavior; dropped frames must not become a success indicator.

## 8. Notifications independent of UI state

Normalize events in the Desktop backend for all subscribed sessions, including
inactive tabs. The UI completion counter is not a durable event identifier.
Do not derive task completion from `busy` becoming false.

| Event | Required evidence |
| --- | --- |
| `response_available` | A newly completed persisted response entry, with a stable local session/entry identity. |
| `input_required` | A current supported host interaction request; not an arbitrary idle interval or a question inferred from response text. |
| `attention_error` | An error requiring attention under a defined recovery rule; distinguish transient failures followed by retry/fallback. |
| `process_exited` | A confirmed exit of the relevant runtime. |
| `device_unreachable` | Missed presence according to the declared threshold; not proof that the machine or agent stopped. |

A local event record includes the stable event identity, approved remote session
ID, event kind, observed time, policy revision, and delivery state. Deduplicate
from durable session/request evidence and keep a bounded local outbox. Recheck
notification policy before delivery; disabling notifications must cancel obsolete
queued sends. Recovery must not resend old history as newly completed work.

Telegram delivery uses bounded retries and explicit outcome tracking. Do not
promise exactly-once delivery when an external send times out with an unknown
result. Event deduplication and transport delivery are different guarantees.

Default notifications contain an owner-chosen alias and event type, with no
response or tool-output text. A content preview is a separate explicit option:
it sends selected content outside Collab end-to-end encryption to the Remote
service and Telegram. Explain that consequence when enabling it.
Notification-only sessions must not start Collab merely to obtain events.
Deep links carry an opaque routing ID, not a Collab secret or authority grant.

## 9. Login, pairing, and trust

Telegram Mini App login validates raw signed `initData` server-side, including
freshness; `initDataUnsafe` is not evidence. Browser login uses Telegram OIDC
Authorization Code with PKCE and a verified login transaction. Validate issuer,
audience, signature, expiry, and applicable state/nonce checks. Keep the OIDC
client secret and bot token out of Desktop and browser code.

OIDC `sub` and Telegram user `id` are distinct claims. Store the OIDC
issuer/subject pair, and link the verified profile `id` to validated Mini App
`user.id`. Usernames are display data. Do not request the phone scope when it is
not needed. Bot messaging permission is separate from login (`telegram:bot_access`
or the Mini App write-access flow); a blocked bot must not disable session access.

Pairing challenges are short-lived, one-use, transaction-bound, and rate-limited
from the first externally accessible build. Desktop displays the account and
client being enrolled, and the user confirms the pairing locally once. Subsequent
opens of permitted sessions do not require repeated local approval. Define local
recovery and unpairing so loss of a Telegram account does not leave the owner
unable to stop sharing from Desktop.

The v1 service is a trusted identity and routing component. An encrypted
capability envelope reduces accidental exposure in server logs and storage; it
does not, by itself, protect against that service substituting a browser key.
A stronger authorization mode must bind the ephemeral key and signed open request
to a client key previously approved by Desktop. Use reviewed standard mechanisms
instead of inventing a new cryptographic protocol.

Even with a bound client key, the source that supplies browser JavaScript remains
trusted for handling decrypted data. Do not claim that server compromise can
never expose session contents. Serve a controlled client build, minimize scripts,
use appropriate CSP/origin separation, and test the actual browser/Mini App login
and navigation behavior.

Long-lived Desktop credentials require an explicit protected-storage policy.
Existing provider-secret fallback storage is not automatically acceptable for
remote device credentials. If protected storage is unavailable, report the
condition rather than silently changing the promised protection level.

## 10. Data handling and availability

The control service may store owner/device/client IDs, approved aliases, presence,
bounded session status, model display metadata when enabled, grant revisions,
notification policy, and sanitized audit outcomes. Local absolute paths, session
JSONL, prompts, responses, provider keys, environment values, Collab URLs, room
keys, and write tokens are not persisted there.

Treat `collab link` stdout as a secret-bearing channel. Never copy it into generic
command error details, telemetry, test snapshots, crash reports, or diagnostics.
Apply the same rule to local registry bearer tokens. The application must not
persist ephemeral Collab secrets; this is not a guarantee that the operating
system or browser never writes process memory to disk.

Offer a remote display alias at first publication. A session title can reveal
the project even without its transcript. Avoid publishing unselected sessions
or using the raw local working directory as an alias.

Relay, control-service, Telegram, and Desktop failures are independent. A lost
control connection must not be described as a stopped agent or revoked Collab
room. A lost browser connection must not stop local work. Desktop exit still
terminates its managed processes under the current architecture. V1 does not
promise wake-on-LAN, unattended relaunch, offline cloud history, or survival after
application exit.

The hosted Collab relay remains an external dependency. The upstream local relay
is a development stand-in, not evidence of a supported production self-hosting
deployment. Keep this distinction in setup and support documentation.

## 11. Phase 0 acceptance and evidence

Use synthetic sessions, an isolated configuration root, and bounded local fixtures.
Do not enumerate or publish the user's actual sessions, use their credentials,
or contact model providers for this spike. Native runtime checks, when available,
must use explicitly prepared test data and report their exact installed version.

| Scenario | Acceptance result |
| --- | --- |
| Capability probe | Required fields and operations are classified as supported, unsupported, or unknown; version strings alone do not enable the feature. |
| Target binding | Only the exact permitted runtime/session is opened; PID reuse, duplicate matches, and untrusted display strings cannot redirect access. |
| Stale dashboard / rotated room | Old binding is rejected; a different successor session is never opened silently. |
| Grant/revoke race | Old-policy or old-client-epoch link results are discarded before release; a browser drops superseded responses. |
| Lifecycle acknowledgement race | A late start cannot reverse Off, and a stop for an old generation cannot mark a successor Off. |
| Manual sharing after a grant | Independent sharing has separate status; manual changes do not erase Remote's outstanding revocation obligations. |
| View | Host rejects mutations, including attempts outside the UI. |
| Control to View | Previously issued control capability cannot mutate after confirmed downgrade. |
| Off | Previously issued grants no longer provide access; managed sharing cannot rehost from an unchanged auto-start policy. |
| Same-session restart / verified handoff | Policy follows only the permitted identity transition; all capabilities are renewed. |
| Unrelated resume / import / fork | No policy inheritance from a terminal, PID, title, or directory. |
| Unknown send outcome | No automatic replay; draft and uncertainty remain visible. |
| Host dialog race | Closure is not falsely reported as acceptance of this client's answer. |
| Notifications on background tabs | Stable new-event detection works without activating the tab; restart does not replay history. |
| Notification-only policy | No Collab room is created as a side effect. |
| Secret-bearing failures | Reports and diagnostics contain no capabilities, registry tokens, raw subprocess output, or local paths. |
| Dependency outage / application exit | State distinguishes unavailable, revoked, stopped, and unknown; local work continues where the underlying runtime remains alive. |

Record each row as source-inspected, fixture-verified, native-verified, blocked,
or not exercised. Fixture success does not establish real OMP lifecycle behavior,
Windows named-pipe ACLs, mobile WebCrypto, or Telegram authentication. A compatibility
prototype can demonstrate supported seams while explicitly refusing unsupported
ones; it must not simulate a successful production toggle.

## 12. Delivery milestones

1. **Local compatibility and authority boundary.** Establish exact-target opening,
   policy transitions, and honest unsupported behavior. Determine the smallest
   upstream lifecycle API required for integrated start/stop/downgrade.
2. **Backend events.** Introduce durable response/interaction/error identities and
   policy-aware notification scheduling independently of the selected UI tab.
3. **One complete paired workflow.** Enroll a Desktop and client, list approved
   sessions, open one, send with honest delivery state, and revoke access with
   local confirmation.
4. **Responsive browser and Mini App.** Integrate a pinned Collab client and test
   mobile reconnect, dialog races, login, and switching between devices/sessions.
5. **Release qualification.** Validate native Windows/Linux behavior, every
   required revocation scenario, login/pairing abuse limits, storage policy,
   redaction, and outage reporting before enabling access outside the test setup.

Keep the feature disabled by default until its required lifecycle contracts are
available and verified. A local proof of concept, Draft PR, or passing ordinary
CI does not imply deployment, production compatibility, or permission to expose
existing sessions. Do not make unrelated UI, provider, or session lifecycle
changes part of this feature's initial patch.

## References

- [Original issue #103 (closed `not_planned`)](https://github.com/Omnividente/omp-desktop/issues/103) and [Discussion #104](https://github.com/Omnividente/omp-desktop/discussions/104).
- [OMP Collab documentation at the reviewed revision](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/docs/collab.md).
- [Collab controller](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/coding-agent/src/collab/controller.ts), [registry](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/coding-agent/src/collab/registry.ts), and [wire protocol](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/wire/src/index.ts).
- [Browser socket queue](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/collab-web/src/lib/socket.ts) and [composer](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/collab-web/src/components/shell/Composer.tsx).
- [Desktop terminal lifecycle](https://github.com/Omnividente/omp-desktop/blob/ce1a497fb7988a7c4ed305ef2890436342c9f7ad/src-tauri/src/terminal.rs), [runtime events](https://github.com/Omnividente/omp-desktop/blob/ce1a497fb7988a7c4ed305ef2890436342c9f7ad/src/runtimeEvents.ts), [completed answers](https://github.com/Omnividente/omp-desktop/blob/ce1a497fb7988a7c4ed305ef2890436342c9f7ad/src/CompletedAnswers.tsx), and [application exit](https://github.com/Omnividente/omp-desktop/blob/ce1a497fb7988a7c4ed305ef2890436342c9f7ad/src-tauri/src/lib.rs).
- [Telegram Login / OIDC](https://core.telegram.org/bots/telegram-login) and [Mini Apps](https://core.telegram.org/bots/webapps).
- [Web Cryptography security considerations](https://www.w3.org/TR/webcrypto-1/#security-considerations).

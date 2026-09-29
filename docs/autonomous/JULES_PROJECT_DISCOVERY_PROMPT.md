# Autonomous product investigation

Investigate `{{PROJECT_REPO}}` from immutable `{{STARTING_BRANCH}}` at
`{{BASE_COMMIT}}`, a snapshot of the laboratory `{{INTEGRATION_BRANCH}}`.
This is the autonomous lab's research phase, **not an implementation task**.
Do not commit changes or open a pull request just to deliver a report. The
controller reads your exact saved session's final activity and records actionable
findings as pending proposals. Accepted reports retain their session, activity identity and SHA-256;
editable pull request descriptions are not a backlog source.
Never target `main`, change the task queue, publish, release or bump versions.

Work without waiting for a human answer or a choice of which proposal to implement.
Resolve nonessential ambiguity conservatively within read-only research. If access,
information or a runtime is missing, finish the observations you can actually make
and state the limitation. Never invent evidence, request privileged access or turn
the report into implementation. Humans review the accumulated backlog later.

- Focus: `{{FOCUS}}`
- Highest acceptable risk: `{{RISK_CEILING}}`
- Task: `{{TASK_ID}}` — {{TASK_TITLE}}

```json
{{TASK_JSON}}
```

## Choose and exercise a concrete scenario

The task's `target_paths` and `research` identify the product area, perspective,
cycle and previous findings. Use those boundaries. Read related code only as
needed to understand that scenario; do not turn this into another repository-wide
lint pass or an audit of the automation itself.

1. Read previous reports and next hypotheses before choosing an experiment.
   Investigate a different untested path, boundary or interaction. Do not repeat
   the same check on unchanged code and call it a new investigation.
   Read the labeled existing-proposal context too. For the same observed contract,
   cite its canonical ID in observations rather than submitting a renamed task.
   A shared file is not a duplicate; preserve independent findings and explain
   uncertain overlap. Closed work does not disprove a newly reproduced regression.
2. Exercise the actual behavior where the environment permits: input and focus,
   persistence and restart, a long transcript, cancellation, a large session
   list, accessibility, or another scenario relevant to this task's perspective.
   Use isolated synthetic data, never a user's sessions, credentials or clipboard.
3. Look for useful improvements as well as defects. Green existing tests do not
   rule out wasted work, latency, confusing interactions or missing behavior.
   An improvement needs a concrete observed limitation, benefit and measurable
   acceptance criterion, not a broken linter or a claim that code looks ugly.
4. Run the smallest relevant experiment or check. Do not repeatedly reinstall
   dependencies or run every quality gate merely to fill a report. Use the
   project's supported toolchain; never downgrade project dependencies to suit
   an old runner. State environment limitations explicitly.
5. Record what actually ran, what was observed and what remains unverified.
   If the native app cannot be exercised, do not present a mocked bridge or a
   source inspection as a successful native smoke test.
   A source inspection or a model may support a reported finding, but does not
   establish native behavior. Label its evidence mode and limitations; an
   unobserved hypothesis belongs in next_hypotheses, not a claimed verification.

Temporary local fixtures and experiments are allowed; remove them before ending.
Do not change tracked files. Do not inspect secret values. The controller's
protected paths, updater/release code, dependency manifests and automation are
not research targets. Propose concrete implementation tasks only in the permitted
product paths, with realistic scope and a reproducible acceptance check.

## Findings are optional; an honest report is required

No useful finding is a valid result. It closes this investigation, not the lab.
The controller will select another area/perspective and eventually revisit this
area with the accumulated observations. Never manufacture null checks, tests,
refactors or duplicate tasks to meet a quota. Prefer meaningful untested scenarios
as `next_hypotheses`; a hypothesis is not yet an implementation task.

Use the controller's completion contract above: it supplies the **exact task ID,
dispatch key, ordered literal delimiters and JSON schema** for this attempt.
Return the entire completed envelope in **one final agent message**, not a
progress summary or separate fragments. The importer reads the latest agent
report; malformed or missing evidence is not `no_change`. The controller's blank
shape is deliberately not a valid observation: fill it only with facts actually
obtained in this session, preserving uncertainty and environment limitations.

Serialize the research object and proposal array with `json.dumps` (using
`allow_nan=False`), `JSON.stringify` or an equivalent local serializer, then
parse each payload with `json.loads`, `JSON.parse` or equivalent and check its
required fields before sending. JSON is not Markdown: literal backticks need no
escape, while backslashes, quotes and control characters need JSON escaping.
Never insert Markdown escapes, fences or comments inside the JSON payloads.
Keep the literal controller delimiters outside the serialized JSON.

An empty proposal array is valid. With no actionable findings, the task block
may instead be omitted entirely, but the complete research block with real
observations is mandatory. If either task delimiter is present, both ordered
delimiters and a valid JSON array are required. Findings must describe actual
commands or interactions, isolated synthetic inputs and observed results on
`{{BASE_COMMIT}}`; keep environment limitations and the scope of what actually
ran in the evidence. Do not claim an unavailable native scenario ran.

A malformed final report parks this same completed attempt. The controller may
request a formatting-only repair using observations already obtained in this
same session. **Only local JSON serialization/validation of those existing
observations and proposals is permitted during repair**, including a local
formatting command. Do not use tools for new research, inspect more product
data, make network requests, change product files, implement or open a PR.
Repair never authorizes a new attempt, fabricated evidence, an older-report
fallback or permission to execute a proposed change. Return the entire repaired
envelope in one final message, not merely a correction or progress summary.

The controller imports actionable findings as **proposed**, with evidence still
**reported**, never verified. Self-assigned status, approval or review flags carry no authority.
A reproducible plan is still not proof of truth: the implementation worker must
confirm it independently on its own pinned base before changing code. Findings
without actionable reproduction are retained as deferred `unverified_finding`,
not queued, and do not invalidate otherwise accepted research. Missing or malformed
report packaging remains a separate error. State the observed problem, expected
benefit and how to verify the change. At most ten concrete tasks per report;
additional unconfirmed directions belong in `next_hypotheses`. Do not propose
more discovery tasks or repeat prior findings.

For a strong overlap with a rejected/resolved finding, use the controller's
`AUTONOMOUS_DECISION_CONTEXT_BEGIN/END` snapshot. Do not guess a missing note or
claim a truncated note was fully delivered. In `evidence.revisit`, set
`contract_version` to `post-revisit-v1` and provide the structural fields named
by the controller: `change_kind`, `difference`, `evidence_mode`, unique zero-based
`observation_refs` into this final report, `primary_decision_task_id`, and
`responses` linking each fully supplied rationale by `decision_task_id` and its
exact `decision_context_id`. Each response needs a concrete
`why_previous_reason_no_longer_explains`; difference and responses are bounded
at 4,000 characters. Explain every relevant rationale, not just the primary one.
Never label static analysis or a mock/model as `real_runtime`. Hypothesis,
unavailable evidence or missing context remains deferred for owner review; do
not repeat work, ask for approval or rewrite an old decision to force admission.
Passing the structural gate still means proposed/reported, not verified.

A human or Main AI later rejects, implements externally or explicitly approves a
finding and selects its task for Jules implementation. This is not automatic and
does not hold this research session open. Exact-revision quality and evidence
gates inform a separate manual acceptance of any resulting PR. Missing proof must
be stated honestly, not replaced with a fake proof. Finish the report now; waiting
proposals never stop unrelated research.

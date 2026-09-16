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
   Source reading is not an experiment. Do not promote a hypothesis into an
   implementation finding without observing the defect or measurable limitation.

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

Finish with the exact task and dispatch markers from the top of this prompt and
the machine-readable blocks below. Put the **complete final report together in
one final agent message**, not fragmented across progress updates. The importer
uses the latest agent report; malformed or missing evidence is not `no_change`.

```text
AUTONOMOUS_TASK_ID: {{TASK_ID}}
AUTONOMOUS_DISPATCH_KEY: <copy the exact key from the top of this prompt>
```

```text
<!-- AUTONOMOUS_RESEARCH_BEGIN -->
{
  "summary": "Short conclusion for this area and scenario",
  "observations": [
    {
      "scenario": "The exact user action, boundary or workload exercised",
      "evidence": "Command or interaction, relevant files, actual result or measurements",
      "result": "What this establishes and what it does not establish"
    }
  ],
  "next_hypotheses": ["A distinct scenario worth investigating next"]
}
<!-- AUTONOMOUS_RESEARCH_END -->
<!-- AUTONOMOUS_TASKS_BEGIN -->
[]
<!-- AUTONOMOUS_TASKS_END -->
```

The task array may be omitted entirely when there are no actionable findings,
but the complete research block with real observations remains mandatory. If
either task delimiter is present, both ordered delimiters and a valid JSON array
are required. A malformed final report parks this same completed attempt for
inspection and explicit report reharvesting; it does not launch another research
session or silently fall back to an older report.

Replace the empty task array only when there are actionable findings. Each entry
must contain `title`, `task_type` (`bugfix` or `product_improvement`), `risk`,
`priority` (1–90), and non-empty string arrays `focus`, `target_paths` and
`acceptance`. Paths must be concrete and repository-relative. `acceptance` must
be an array even for one criterion, never a string. Include `evidence.source`,
`evidence.detail` and an actionable `evidence.reproduction` object: a non-empty
`steps` array of nonblank strings, and nonblank `expected` and `actual` strings.
Give exact commands or interactions, isolated synthetic inputs and the observed
result on `{{BASE_COMMIT}}`; put environment limitations and the scope of what was
actually exercised in `detail`. Do not claim an unavailable native scenario ran.

For example, the task block for an actually observed finding has this shape
(replace this illustrative scenario with your own observations; do not copy it
as a finding):

```text
<!-- AUTONOMOUS_TASKS_BEGIN -->
[
  {
    "title": "Refresh the displayed clock after resume",
    "task_type": "bugfix",
    "risk": "low",
    "priority": 45,
    "focus": ["quality"],
    "target_paths": ["src/clock.ts"],
    "acceptance": ["Resuming refreshes the clock to the current system time"],
    "evidence": {
      "source": "product_research",
      "detail": "Native desktop observation with an empty synthetic profile; no real user data. Only resume was exercised.",
      "reproduction": {
        "steps": ["Launch the pinned base with an empty synthetic profile and note the displayed time", "Suspend the host for two minutes, then resume and inspect the displayed time"],
        "expected": "The clock displays the current system time after resume",
        "actual": "The clock still displays the time recorded before suspend"
      }
    }
  }
]
<!-- AUTONOMOUS_TASKS_END -->
```

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

A human or Main AI later rejects, implements externally or explicitly approves a
finding and selects its task for Jules implementation. This is not automatic and
does not hold this research session open. Exact-revision quality and evidence
gates inform a separate manual acceptance of any resulting PR. Missing proof must
be stated honestly, not replaced with a fake proof. Finish the report now; waiting
proposals never stop unrelated research.

# Autonomous product investigation

Investigate `{{PROJECT_REPO}}` on `{{INTEGRATION_BRANCH}}` at `{{BASE_COMMIT}}`.
This is the autonomous lab's research phase, **not an implementation task**.
Do not commit changes or open a pull request just to deliver a report. The
controller reads your final session message and queues actionable findings.
Never target `main`, change the task queue, publish, release or bump versions.

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
be an array even for one criterion, never a string. Include
`evidence: {"source": "product_research", "detail": "..."}`.
State the observed problem, expected benefit and how to verify the change. At
most ten concrete tasks per report; additional unconfirmed directions belong in
`next_hypotheses`. Do not propose more discovery tasks or repeat prior findings.

The next worker implements one concrete task separately. Existing exact-revision
quality and evidence gates still decide whether its change can enter the lab.
Work that cannot be accepted automatically remains visible for later human
review; it does not require a fake proof and must not stop unrelated research.

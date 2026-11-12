import { describe, expect, it } from "vitest"
import { matchesIncidentSearch } from "./incidentSearch"
import type { RuntimeIncident } from "./runtimeIncidents"

const incident: RuntimeIncident = {
  id: "runtime-incident-1",
  groupingKey: "hidden-group",
  terminalId: "terminal-17",
  terminalLabel: "Recorded task",
  kind: "fallback",
  sourceKind: "retryFallbackApplied",
  status: "active",
  role: "reviewer",
  model: "hidden-model",
  modelRole: "hidden-role",
  fallbackRole: "hidden-fallback-role",
  fallbackFrom: "provider/primary",
  fallbackTo: "provider/backup",
  reason: "Rate limit [429]. Retry after 30 seconds.",
  count: 1,
  firstSeenAt: 1000,
  lastSeenAt: 1000,
  resolvedAt: null,
  resolutionReason: null,
}

describe("retained incident text search", () => {
  it.each(["", "   ", "  [429]  ", "REVIEWER", "terminal-17", "recorded", "PRIMARY", "backup"])(
    "matches a literal diagnostic field or an empty query: %j",
    (query) => {
      expect(matchesIncidentSearch(incident, undefined, query)).toBe(true)
    },
  )

  it.each([".*", "[42]", "hidden-group", "hidden-role", "hidden-fallback-role", "hidden-model"])(
    "does not search regular expressions or hidden fields: %j",
    (query) => {
      expect(matchesIncidentSearch(incident, undefined, query)).toBe(false)
    },
  )

  it("uses the displayed current title, then the recorded title after the tab disappears", () => {
    expect(matchesIncidentSearch(incident, "Current task", "recorded")).toBe(false)
    expect(matchesIncidentSearch(incident, "Current task", "current")).toBe(true)
    expect(matchesIncidentSearch(incident, undefined, "recorded")).toBe(true)
    expect(matchesIncidentSearch(incident, "", "recorded")).toBe(false)
  })

  it("matches canonical Unicode without changing the title or removing accents", () => {
    const title = "Cafe\u0301 Ёж 日本語 😀"
    expect(matchesIncidentSearch(incident, title, "CAFÉ")).toBe(true)
    expect(matchesIncidentSearch(incident, "Café", "cafe\u0301")).toBe(true)
    expect(matchesIncidentSearch(incident, title, "ёж")).toBe(true)
    expect(matchesIncidentSearch(incident, title, "日本語 😀")).toBe(true)
    expect(matchesIncidentSearch(incident, title, "cafe")).toBe(false)
  })

  it("includes the full expandable reason, while keeping field boundaries distinct", () => {
    const long = { ...incident, reason: `${"prefix ".repeat(40)}FINAL-DIAGNOSTIC` }
    expect(matchesIncidentSearch(long, undefined, "final-diagnostic")).toBe(true)
    expect(matchesIncidentSearch(incident, undefined, "reviewer rate")).toBe(false)
  })

  it("only includes the fallback model that the row actually displays", () => {
    const noTarget = { ...incident, fallbackTo: null }
    expect(matchesIncidentSearch(noTarget, undefined, "hidden-model")).toBe(true)
    const emptyTarget = { ...noTarget, fallbackTo: "" }
    const modelError = { ...incident, kind: "modelError" as const }
    expect(matchesIncidentSearch(emptyTarget, undefined, "hidden-model")).toBe(false)
    expect(matchesIncidentSearch(modelError, undefined, "primary")).toBe(false)
  })

  it("accepts missing diagnostic fields and leaves frozen input untouched", () => {
    const empty = Object.freeze({
      ...incident,
      terminalLabel: null,
      role: null,
      reason: null,
      fallbackFrom: null,
      fallbackTo: null,
      model: null,
    })
    const before = { ...empty }
    expect(matchesIncidentSearch(empty, undefined, "missing")).toBe(false)
    expect(matchesIncidentSearch(empty, undefined, "terminal-17")).toBe(true)
    expect(empty).toEqual(before)
  })
})

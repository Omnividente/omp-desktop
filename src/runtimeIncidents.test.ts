import { describe, expect, it } from "vitest"
import {
  MAX_RUNTIME_INCIDENTS,
  activeRuntimeTerminalCount,
  applyRuntimeIncidentEvent,
  clearResolvedRuntimeIncidents,
  createRuntimeIncidentState,
  endRuntimeIncidentTerminal,
  runtimeHealthStatus,
  type RuntimeIncidentState,
} from "./runtimeIncidents"
import type { PtyRuntimeEvent } from "./types"

function runtimeEvent(overrides: Partial<PtyRuntimeEvent> = {}): PtyRuntimeEvent {
  return {
    terminalId: "terminal-1",
    kind: "activity",
    model: null,
    modelRole: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    activity: null,
    errorMessage: null,
    fallbackFrom: null,
    fallbackTo: null,
    fallbackRole: null,
    resolvedModelIsFallback: null,
    ...overrides,
  }
}

function fallbackEvent(overrides: Partial<PtyRuntimeEvent> = {}): PtyRuntimeEvent {
  return runtimeEvent({
    kind: "retryFallbackApplied",
    model: "provider/fallback",
    modelRole: null,
    activity: "thinking",
    fallbackFrom: "provider/primary",
    fallbackTo: "provider/fallback:high",
    fallbackRole: "default",
    ...overrides,
  })
}

function errorEvent(overrides: Partial<PtyRuntimeEvent> = {}): PtyRuntimeEvent {
  return runtimeEvent({
    kind: "modelError",
    modelRole: "default",
    activity: "error",
    errorMessage: "stream error: 429 Too Many Requests",
    ...overrides,
  })
}

function apply(
  state: RuntimeIncidentState,
  event: unknown,
  now: number,
  label = "Session A",
): RuntimeIncidentState {
  return applyRuntimeIncidentEvent(state, event, now, label)
}

describe("runtime incident grouping", () => {
  it("opens one active fallback group with exact transition metadata", () => {
    const state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({
      id: "runtime-incident-1",
      terminalId: "terminal-1",
      terminalLabel: "Session A",
      kind: "fallback",
      sourceKind: "retryFallbackApplied",
      status: "active",
      role: "default",
      fallbackFrom: "provider/primary",
      fallbackTo: "provider/fallback:high",
      count: 1,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      resolvedAt: null,
    })
    expect(state.incidents[0].groupingKey).toContain("retryFallbackApplied")
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")
  })

  it.each([10, 100])("coalesces %i exact fallback repeats into one group", (count) => {
    let state = createRuntimeIncidentState(0)
    for (let index = 0; index < count; index += 1) {
      state = apply(state, fallbackEvent(), 1_000 + index)
    }

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0].count).toBe(count)
    expect(state.incidents[0].lastSeenAt).toBe(999 + count)
  })

  it("coalesces 100 exact error repeats into one group", () => {
    let state = createRuntimeIncidentState(0)
    for (let index = 0; index < 100; index += 1) {
      state = apply(state, errorEvent(), 2_000 + index)
    }

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({ kind: "modelError", count: 100 })
  })

  it("keeps different terminals, event kinds, roles, transitions, and reasons separate", () => {
    const variants = [
      errorEvent(),
      errorEvent({ terminalId: "terminal-2" }),
      errorEvent({ kind: "runtimeError" }),
      errorEvent({ modelRole: "review" }),
      errorEvent({ fallbackRole: "review" }),
      errorEvent({ fallbackFrom: "provider/other" }),
      errorEvent({ fallbackTo: "provider/other-fallback" }),
      errorEvent({ errorMessage: "stream error: 503 unavailable" }),
    ]
    let state = createRuntimeIncidentState(0)
    variants.forEach((event, index) => {
      state = apply(state, event, 3_000 + index)
    })

    expect(state.incidents).toHaveLength(variants.length)
    expect(new Set(state.incidents.map((incident) => incident.groupingKey)).size).toBe(
      variants.length,
    )
  })

  it("keeps different fallback roles and from-to edges separate", () => {
    const variants = [
      fallbackEvent(),
      fallbackEvent({ fallbackRole: "review" }),
      fallbackEvent({ fallbackFrom: "provider/other" }),
      fallbackEvent({ fallbackTo: "provider/another:high", model: "provider/another" }),
      fallbackEvent({ errorMessage: "quota exhausted" }),
    ]
    let state = createRuntimeIncidentState(0)
    variants.forEach((event, index) => {
      state = apply(state, event, 4_000 + index)
    })

    expect(state.incidents).toHaveLength(variants.length)
  })
})

describe("runtime incident transitions", () => {
  it.each(["thinking", "idle"] as const)("resolves an error after %s activity", (activity) => {
    let state = apply(createRuntimeIncidentState(0), errorEvent(), 1_000)
    state = apply(state, runtimeEvent({ kind: "activity", activity }), 1_100)

    expect(state.incidents[0]).toMatchObject({
      status: "resolved",
      resolvedAt: 1_100,
      resolutionReason: "recovered",
    })
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("normal")
  })

  it("resolves errors through fallback and keeps fallback active", () => {
    let state = apply(createRuntimeIncidentState(0), errorEvent(), 1_000)
    state = apply(state, fallbackEvent(), 1_100)

    expect(state.incidents).toHaveLength(2)
    expect(state.incidents.find((incident) => incident.kind === "modelError")).toMatchObject({
      status: "resolved",
      resolutionReason: "recoveredThroughFallback",
    })
    expect(state.incidents.find((incident) => incident.kind === "fallback")).toMatchObject({
      status: "active",
      role: "default",
    })
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")
  })

  it("preserves fallback through thinking and idle activity", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(state, runtimeEvent({ kind: "activity", activity: "thinking" }), 1_100)
    state = apply(state, runtimeEvent({ kind: "activity", activity: "idle" }), 1_200)

    expect(state.incidents[0].status).toBe("active")
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")
  })

  it("resolves fallback only on explicit non-fallback model change or terminal end", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(
      state,
      runtimeEvent({
        kind: "modelChange",
        model: "provider/unknown",
        modelRole: "default",
        resolvedModelIsFallback: null,
      }),
      1_100,
    )
    expect(state.incidents[0].status).toBe("active")

    state = apply(
      state,
      runtimeEvent({
        kind: "modelChange",
        model: "provider/primary",
        modelRole: "default",
        resolvedModelIsFallback: false,
      }),
      1_200,
    )
    expect(state.incidents[0]).toMatchObject({
      status: "resolved",
      resolutionReason: "primaryRestored",
    })
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("normal")

    state = apply(state, fallbackEvent(), 1_300)
    state = endRuntimeIncidentTerminal(state, "terminal-1", 1_400)
    expect(state.incidents[0]).toMatchObject({
      status: "resolved",
      resolutionReason: "terminalEnded",
    })
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("normal")
  })

  it("gives error priority over fallback and returns to fallback after recovery", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(state, errorEvent(), 1_100)

    expect(runtimeHealthStatus(state, "terminal-1")).toBe("error")
    expect(activeRuntimeTerminalCount(state)).toBe(1)

    state = apply(state, runtimeEvent({ kind: "activity", activity: "thinking" }), 1_200)
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")
  })

  it("creates generic fallback history when modelChange is the only fallback signal", () => {
    const state = apply(
      createRuntimeIncidentState(0),
      runtimeEvent({
        kind: "modelChange",
        model: "provider/fallback",
        modelRole: "default",
        resolvedModelIsFallback: true,
      }),
      1_000,
    )

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({
      kind: "fallback",
      sourceKind: "modelChange",
      role: "default",
      fallbackFrom: null,
      fallbackTo: "provider/fallback",
      status: "active",
    })
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")
  })

  it("does not duplicate a retry transition when matching modelChange arrives", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(
      state,
      runtimeEvent({
        kind: "modelChange",
        model: "provider/fallback",
        modelRole: "default",
        resolvedModelIsFallback: true,
      }),
      1_100,
    )

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({ sourceKind: "retryFallbackApplied", count: 1 })
  })

  it("reopens a resolved exact incident on recurrence", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(
      state,
      runtimeEvent({
        kind: "modelChange",
        model: "provider/primary",
        modelRole: "default",
        resolvedModelIsFallback: false,
      }),
      1_100,
    )
    state = apply(state, fallbackEvent(), 1_200)

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({
      status: "active",
      count: 2,
      firstSeenAt: 1_000,
      lastSeenAt: 1_200,
      resolvedAt: null,
      resolutionReason: null,
    })
  })

  it("resolves fallback by role and uses terminal-wide recovery when role is absent", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(
      state,
      fallbackEvent({
        model: "provider/review-fallback",
        fallbackTo: "provider/review-fallback",
        fallbackRole: "review",
      }),
      1_100,
    )
    state = apply(
      state,
      runtimeEvent({
        kind: "modelChange",
        modelRole: "default",
        resolvedModelIsFallback: false,
      }),
      1_200,
    )

    expect(state.incidents.find((incident) => incident.role === "default")?.status).toBe("resolved")
    expect(state.incidents.find((incident) => incident.role === "review")?.status).toBe("active")
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("fallback")

    state = apply(
      state,
      runtimeEvent({ kind: "modelChange", resolvedModelIsFallback: false }),
      1_300,
    )
    expect(state.incidents.every((incident) => incident.status === "resolved")).toBe(true)
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("normal")
  })

  it("leaves incident state unchanged for thinkingLevelChange", () => {
    const state = apply(createRuntimeIncidentState(0), errorEvent(), 1_000)
    const next = apply(
      state,
      runtimeEvent({ kind: "thinkingLevelChange", thinkingLevel: "high" }),
      1_100,
    )
    expect(next).toBe(state)
  })
})

describe("runtime incident bounds and cleanup", () => {
  it("clear resolved never removes active incidents", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(
      state,
      runtimeEvent({ kind: "modelChange", modelRole: "default", resolvedModelIsFallback: false }),
      1_100,
    )
    state = apply(state, errorEvent({ terminalId: "terminal-2" }), 1_200, "Session B")

    state = clearResolvedRuntimeIncidents(state, 1_300)
    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({ terminalId: "terminal-2", status: "active" })
    expect(runtimeHealthStatus(state, "terminal-2")).toBe("error")
  })

  it("terminal exit/close is idempotent and clears health", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1_000)
    state = apply(state, errorEvent(), 1_100)

    const ended = endRuntimeIncidentTerminal(state, "terminal-1", 1_200)
    const repeated = endRuntimeIncidentTerminal(ended, "terminal-1", 1_300)

    expect(repeated).toBe(ended)
    expect(ended.incidents.every((incident) => incident.status === "resolved")).toBe(true)
    expect(ended.incidents.every((incident) => incident.resolvedAt === 1_200)).toBe(true)
    expect(ended.healthByTerminal).not.toHaveProperty("terminal-1")
  })

  it("keeps 1,000+ distinct groups within the hard limit", () => {
    let state = createRuntimeIncidentState(0)
    for (let index = 0; index < 1_250; index += 1) {
      state = apply(state, errorEvent({ errorMessage: `exact failure ${index}` }), 10_000 + index)
    }

    expect(state.incidents).toHaveLength(MAX_RUNTIME_INCIDENTS)
    expect(state.sequence).toBe(1_250)
    expect(state.incidents.some((incident) => incident.reason === "exact failure 0")).toBe(false)
    expect(runtimeHealthStatus(state, "terminal-1")).toBe("error")
  })

  it("evicts the oldest resolved group before any active group", () => {
    let state = apply(createRuntimeIncidentState(0), fallbackEvent(), 1)
    state = apply(
      state,
      runtimeEvent({ kind: "modelChange", modelRole: "default", resolvedModelIsFallback: false }),
      2,
    )
    for (let index = 0; index < MAX_RUNTIME_INCIDENTS - 1; index += 1) {
      state = apply(state, errorEvent({ errorMessage: `active ${index}` }), 10 + index)
    }
    state = apply(state, errorEvent({ errorMessage: "overflow" }), 10_000)

    expect(state.incidents).toHaveLength(MAX_RUNTIME_INCIDENTS)
    expect(state.incidents.some((incident) => incident.kind === "fallback")).toBe(false)
    expect(state.incidents.filter((incident) => incident.status === "active")).toHaveLength(
      MAX_RUNTIME_INCIDENTS,
    )
  })

  it("keeps a long multiline reason exact without a second cache", () => {
    const reason = `Cloud API error (429):\n${"  quota detail ".repeat(120)}\nfinal line`
    const state = apply(createRuntimeIncidentState(0), errorEvent({ errorMessage: reason }), 1_000)

    expect(state.incidents[0].reason).toBe(reason)
    expect(state.incidents[0].groupingKey).toContain(JSON.stringify(reason).slice(1, -1))
    expect(state.incidents).toHaveLength(1)
  })

  it("ignores malformed and unknown runtime events without false incidents", () => {
    const state = createRuntimeIncidentState(0)
    const malformed = apply(state, errorEvent({ errorMessage: "  \n " }), 1_000)
    const unknown = apply(
      malformed,
      { terminalId: "terminal-1", kind: "mystery", errorMessage: "boom" },
      1_100,
    )
    const missingTerminal = apply(unknown, { kind: "modelError", errorMessage: "boom" }, 1_200)

    expect(malformed).toBe(state)
    expect(unknown).toBe(state)
    expect(missingTerminal).toBe(state)
    expect(state.incidents).toHaveLength(0)
    expect(state.healthByTerminal).toEqual({})
  })
})

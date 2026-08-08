import { describe, expect, it } from "vitest"
import { runtimeEventFeedback, runtimeFeedbackDedupeKey } from "./runtimeEvents"
import {
  MAX_TOASTS,
  MAX_TOAST_CHARS,
  MAX_TOAST_LINES,
  TOAST_MUTE_MS,
  TOAST_TTL_MS,
  clampToastMessage,
  createToastState,
  dismissToast,
  enqueueToast,
  expireToasts,
  type ToastRequest,
  type ToastState,
} from "./toastQueue"
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

/** Mirrors what App.tsx builds from a runtime event. */
function toastFor(event: PtyRuntimeEvent): ToastRequest {
  const feedback = runtimeEventFeedback(event)
  if (!feedback) throw new Error("expected runtime feedback for the event")

  return {
    kind: feedback.kind === "fallback" ? "notice" : "error",
    message:
      feedback.kind === "fallback" ? `Switched to fallback: ${feedback.model}` : feedback.message,
    dedupeKey: runtimeFeedbackDedupeKey(event, feedback),
  }
}

const fallbackEvent = runtimeEvent({
  kind: "retryFallbackApplied",
  model: "provider/fallback",
  modelRole: "default",
  activity: "thinking",
  fallbackFrom: "provider/primary",
  fallbackTo: "provider/fallback:high",
  fallbackRole: "default",
})

const errorEvent = runtimeEvent({
  kind: "modelError",
  modelRole: "default",
  activity: "error",
  errorMessage: "stream error: 429 Too Many Requests",
})

/**
 * Replays a stream of identical events through the same expire -> enqueue cycle
 * the UI performs, so a burst or a long stream is fully deterministic.
 */
function replay(
  request: ToastRequest,
  count: number,
  options: { intervalMs?: number; state?: ToastState; start?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 25
  let state = options.state ?? createToastState()
  let now = options.start ?? 1_000
  let created = 0

  for (let index = 0; index < count; index += 1) {
    now += intervalMs
    state = expireToasts(state, now)
    const sequenceBefore = state.sequence
    state = enqueueToast(state, request, now)
    if (state.sequence > sequenceBefore) created += 1
  }

  return { state, created, now }
}

describe("toast queue bounds and coalescing", () => {
  it("delivers a single runtime event as a single toast", () => {
    const { state, created } = replay(toastFor(fallbackEvent), 1)

    expect(created).toBe(1)
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: "notice", count: 1 })
  })

  it("coalesces a burst of 10 identical events into one toast", () => {
    const { state, created } = replay(toastFor(fallbackEvent), 10)

    expect(created).toBe(1)
    expect(state.items).toHaveLength(1)
    expect(state.items[0].count).toBe(10)
  })

  it("coalesces a burst of 100 identical events without growing state", () => {
    const { state, created } = replay(toastFor(errorEvent), 100)

    expect(created).toBe(1)
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: "error", count: 100 })
    expect(state.muted).toHaveLength(0)
  })

  it("coalescing does not extend the lifetime of a toast", () => {
    const request = toastFor(errorEvent)
    let state = enqueueToast(createToastState(), request, 0)
    const [created] = state.items

    for (let index = 1; index < 200; index += 1) {
      state = enqueueToast(state, request, index * 25)
    }

    expect(state.items[0].createdAt).toBe(created.createdAt)
    expect(expireToasts(state, TOAST_TTL_MS).items).toHaveLength(0)
  })

  it("keeps a long stream bounded instead of creating hundreds of notifications", () => {
    const events = 2_000
    const intervalMs = 50
    const { state, created } = replay(toastFor(errorEvent), events, { intervalMs })

    const cycleMs = TOAST_TTL_MS + TOAST_MUTE_MS
    expect(created).toBeLessThanOrEqual(Math.ceil((events * intervalMs) / cycleMs) + 1)
    expect(created).toBeLessThan(events / 100)
    expect(state.items.length).toBeLessThanOrEqual(MAX_TOASTS)
    expect(state.muted.length).toBeLessThanOrEqual(1)
  })

  it("bounds unrelated toasts to the visible window", () => {
    let state = createToastState()

    for (let index = 0; index < 100; index += 1) {
      state = enqueueToast(state, { kind: "notice", message: `notice ${index}` }, 1_000 + index)
    }

    expect(state.items).toHaveLength(MAX_TOASTS)
    expect(state.items[0].message).toBe(`notice ${100 - MAX_TOASTS}`)
    expect(state.items[state.items.length - 1].message).toBe("notice 99")
  })
})

describe("toast identity", () => {
  it("never merges different terminals, roles, or fallback edges", () => {
    const variants = [
      fallbackEvent,
      runtimeEvent({ ...fallbackEvent, terminalId: "terminal-2" }),
      runtimeEvent({ ...fallbackEvent, fallbackRole: "review", modelRole: "review" }),
      runtimeEvent({ ...fallbackEvent, fallbackFrom: "provider/other" }),
    ]

    let state = createToastState()
    variants.forEach((event, index) => {
      state = enqueueToast(state, toastFor(event), 1_000 + index)
    })

    expect(state.items).toHaveLength(variants.length)
    expect(state.items.every((item) => item.count === 1)).toBe(true)
  })

  it("never merges different failure reasons that share a message", () => {
    const message = "stream error: 429 Too Many Requests"
    const keys = [
      runtimeEvent({ kind: "modelError", errorMessage: message }),
      runtimeEvent({ kind: "runtimeError", errorMessage: message }),
      runtimeEvent({ kind: "modelError", errorMessage: message, terminalId: "terminal-2" }),
      runtimeEvent({ kind: "modelError", errorMessage: message, modelRole: "review" }),
      runtimeEvent({ kind: "modelError", errorMessage: `${message} (retry 2)` }),
    ].map((event) => {
      const feedback = runtimeEventFeedback(event)
      if (!feedback) throw new Error("expected runtime feedback for the event")
      return runtimeFeedbackDedupeKey(event, feedback)
    })

    expect(new Set(keys).size).toBe(keys.length)
  })

  it("merges the exact same fallback repeated by retries", () => {
    const repeated = runtimeEvent({ ...fallbackEvent })
    let state = enqueueToast(createToastState(), toastFor(fallbackEvent), 1_000)
    state = enqueueToast(state, toastFor(repeated), 1_050)

    expect(state.items).toHaveLength(1)
    expect(state.items[0].count).toBe(2)
  })
})

describe("dismiss and replay protection", () => {
  it("does not replay a dismissed backlog", () => {
    const request = toastFor(errorEvent)
    const burst = replay(request, 100)
    expect(burst.state.items).toHaveLength(1)

    const dismissed = dismissToast(burst.state, burst.state.items[0].id, burst.now)
    expect(dismissed.items).toHaveLength(0)

    const afterDismiss = replay(request, 100, { state: dismissed, start: burst.now })
    expect(afterDismiss.created).toBe(0)
    expect(afterDismiss.state.items).toHaveLength(0)
  })

  it("does not immediately re-open a toast that timed out", () => {
    const request = toastFor(errorEvent)
    let state = enqueueToast(createToastState(), request, 0)

    state = expireToasts(state, TOAST_TTL_MS)
    expect(state.items).toHaveLength(0)

    state = enqueueToast(state, request, TOAST_TTL_MS + 10)
    expect(state.items).toHaveLength(0)
  })

  it("surfaces the incident again once the mute window has passed", () => {
    const request = toastFor(errorEvent)
    const burst = replay(request, 10)
    const dismissed = dismissToast(burst.state, burst.state.items[0].id, burst.now)

    const later = enqueueToast(dismissed, request, burst.now + TOAST_MUTE_MS + 1)
    expect(later.items).toHaveLength(1)
    expect(later.items[0].count).toBe(1)
  })

  it("dismissing one toast leaves unrelated toasts alone", () => {
    let state = enqueueToast(createToastState(), { kind: "error", message: "first" }, 1_000)
    state = enqueueToast(state, { kind: "notice", message: "second" }, 1_010)
    state = dismissToast(state, state.items[0].id, 1_020)

    expect(state.items.map((item) => item.message)).toEqual(["second"])
  })
})

describe("independent notice and error events", () => {
  it("keeps unrelated notices and errors as separate toasts in order", () => {
    let state = createToastState()
    state = enqueueToast(state, { kind: "notice", message: "Imported 3 sessions" }, 1_000)
    state = enqueueToast(state, { kind: "error", message: "Project directory is required" }, 1_010)
    state = enqueueToast(state, { kind: "notice", message: "Session deleted" }, 1_020)

    expect(state.items.map((item) => [item.kind, item.message])).toEqual([
      ["notice", "Imported 3 sessions"],
      ["error", "Project directory is required"],
      ["notice", "Session deleted"],
    ])
  })

  it("keeps the same text reported as a notice and as an error apart", () => {
    let state = enqueueToast(createToastState(), { kind: "notice", message: "same text" }, 1_000)
    state = enqueueToast(state, { kind: "error", message: "same text" }, 1_001)

    expect(state.items).toHaveLength(2)
  })
})

describe("long and multi-line messages", () => {
  it("leaves ordinary short messages untouched", () => {
    expect(clampToastMessage("Session deleted")).toEqual({
      message: "Session deleted",
      truncated: false,
    })
  })

  it("clamps a multi-line provider error to a few lines", () => {
    const message = [
      "stream error: 429 Too Many Requests",
      "  quota exceeded for the current plan",
      "  retry after 60s",
      "  request id: 0000-1111",
      "  trace: a very long trace line",
    ].join("\r\n")

    const clamped = clampToastMessage(message)

    expect(clamped.message.split("\n")).toHaveLength(MAX_TOAST_LINES)
    expect(clamped.message).not.toContain("request id")
    expect(clamped.truncated).toBe(true)
  })

  it("clamps a very long single-line error and keeps the original for the tooltip", () => {
    const message = `stream error: ${"x".repeat(5_000)}`
    const state = enqueueToast(createToastState(), { kind: "error", message }, 1_000)
    const [toast] = state.items

    expect(toast.message.length).toBeLessThanOrEqual(MAX_TOAST_CHARS + 1)
    expect(toast.truncated).toBe(true)
    expect(toast.fullMessage).toBe(message)
  })

  it("coalesces repeats of a long error instead of stacking them", () => {
    const message = `stream error:\n${"y".repeat(2_000)}`
    const { state, created } = replay({ kind: "error", message }, 100)

    expect(created).toBe(1)
    expect(state.items).toHaveLength(1)
    expect(state.items[0].count).toBe(100)
  })
})

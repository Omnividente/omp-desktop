import { describe, expect, it } from "vitest"
import {
  applyRuntimeEventToTab,
  runtimeEventFeedback,
  suppressTransientProxyError,
} from "./runtimeEvents"
import type { PtyRuntimeEvent, TerminalTab } from "./types"

const tab: TerminalTab = {
  id: "terminal-1",
  label: "Session",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: "provider/primary",
  currentModelRole: "default",
  currentThinking: "medium",
  currentThinkingConfigured: "medium",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}

function event(overrides: Partial<PtyRuntimeEvent>): PtyRuntimeEvent {
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

describe("runtime event contract", () => {
  it("applies model-change payload to the terminal tab", () => {
    const updated = applyRuntimeEventToTab(
      tab,
      event({
        kind: "modelChange",
        model: "provider/new",
        modelRole: "review",
        resolvedModelIsFallback: true,
      }),
    )

    expect(updated.currentModel).toBe("provider/new")
    expect(updated.currentModelRole).toBe("review")
  })

  it("uses fallback metadata without treating the upstream role as a fallback marker", () => {
    const fallback = event({
      kind: "retryFallbackApplied",
      model: "provider/fallback",
      fallbackFrom: "provider/primary",
      fallbackTo: "provider/fallback:high",
      fallbackRole: "default",
      activity: "thinking",
    })

    expect(runtimeEventFeedback(fallback)).toEqual({ kind: "fallback", model: "fallback" })
    expect(applyRuntimeEventToTab(tab, fallback)).toMatchObject({
      currentModel: "provider/fallback",
      currentModelRole: "default",
      activity: "thinking",
    })
    expect(fallback.fallbackRole).toBe("default")
  })

  it.each([
    ["openai/gpt-5.6:high", "openai/gpt-5.6", "gpt-5.6"],
    ["ollama/llama3.1:8b", "ollama/llama3.1:8b", "llama3.1:8b"],
    ["ollama/llama3.1:8b:high", "ollama/llama3.1:8b", "llama3.1:8b"],
    ["ollama/llama3.1:8b:internal", "ollama/llama3.1:8b:internal", "llama3.1:8b:internal"],
  ])(
    "keeps fallbackTo exact while applying %s as currentModel %s",
    (fallbackTo, model, feedbackModel) => {
      const fallback = event({
        kind: "retryFallbackApplied",
        model,
        fallbackTo,
        activity: "thinking",
      })

      expect(runtimeEventFeedback(fallback)).toEqual({
        kind: "fallback",
        model: feedbackModel,
      })
      expect(applyRuntimeEventToTab(tab, fallback).currentModel).toBe(model)
      expect(fallback.fallbackTo).toBe(fallbackTo)
    },
  )

  it("preserves the exact model error for frontend feedback", () => {
    const message = "Cloud API error (429):\n  Individual quota reached"
    const failure = event({
      kind: "modelError",
      activity: "error",
      errorMessage: message,
    })

    expect(runtimeEventFeedback(failure)).toEqual({ kind: "error", message })
    expect(applyRuntimeEventToTab(tab, failure).activity).toBe("error")
  })

  it("does not enqueue a blank runtime error toast", () => {
    expect(
      runtimeEventFeedback(event({ kind: "modelError", activity: "error", errorMessage: "  \n " })),
    ).toBeNull()
  })
})

describe("proxy runtime policy", () => {
  it("suppresses one proxy account error and surfaces a consecutive failure", () => {
    const pending = new Set<string>()
    const failure = event({
      kind: "modelError",
      activity: "error",
      errorMessage: "Previous response owner account is unavailable",
    })

    expect(suppressTransientProxyError(pending, failure, "codex-lb/gpt-5.6", ["codex-lb"])).toBe(
      true,
    )
    expect(suppressTransientProxyError(pending, failure, "codex-lb/gpt-5.6", ["codex-lb"])).toBe(
      false,
    )
  })

  it("re-arms proxy suppression after successful activity", () => {
    const pending = new Set<string>()
    const failure = event({ kind: "modelError", activity: "error", errorMessage: "quota" })
    expect(suppressTransientProxyError(pending, failure, "codex-lb/gpt-5.6", ["codex-lb"])).toBe(
      true,
    )

    expect(
      suppressTransientProxyError(
        pending,
        event({ kind: "activity", activity: "thinking" }),
        "codex-lb/gpt-5.6",
        ["codex-lb"],
      ),
    ).toBe(false)
    expect(suppressTransientProxyError(pending, failure, "codex-lb/gpt-5.6", ["codex-lb"])).toBe(
      true,
    )
  })

  it("never suppresses errors from ordinary providers", () => {
    expect(
      suppressTransientProxyError(
        new Set<string>(),
        event({ kind: "modelError", activity: "error", errorMessage: "quota" }),
        "openai/gpt-5.6",
        ["codex-lb"],
      ),
    ).toBe(false)
  })
})

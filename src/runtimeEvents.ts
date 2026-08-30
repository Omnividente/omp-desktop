import { splitSelector } from "./ModelPicker"
import type { PtyRuntimeEvent, TerminalTab } from "./types"

export type RuntimeEventFeedback =
  { kind: "fallback"; model: string } | { kind: "error"; message: string } | null

export function runtimeEventFeedback(event: PtyRuntimeEvent): RuntimeEventFeedback {
  if (event.kind === "retryFallbackApplied") {
    const selector = event.fallbackTo ?? event.model
    if (selector) {
      const modelSelector = splitSelector(selector).base
      return {
        kind: "fallback",
        model: modelSelector.split("/").at(-1) ?? modelSelector,
      }
    }
  }
  if (typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0) {
    return { kind: "error", message: event.errorMessage }
  }
  return null
}

/**
 * Identity of a piece of runtime feedback, used to coalesce exact repeats.
 *
 * Retries emit the same feedback many times, but a different terminal, role,
 * fallback edge, or failure reason is a different incident and must stay
 * separate.
 */
export function runtimeFeedbackDedupeKey(
  event: PtyRuntimeEvent,
  feedback: NonNullable<RuntimeEventFeedback>,
): string {
  const scope = [event.terminalId, event.kind, event.modelRole ?? ""]

  if (feedback.kind === "fallback") {
    return [
      "runtime-fallback",
      ...scope,
      event.fallbackRole ?? "",
      event.fallbackFrom ?? "",
      event.fallbackTo ?? event.model ?? "",
      feedback.model,
    ].join("|")
  }

  return ["runtime-error", ...scope, feedback.message].join("|")
}

function providerFromSelector(selector: string | null | undefined): string | null {
  if (!selector) return null
  const base = splitSelector(selector).base
  const separator = base.indexOf("/")
  return separator > 0 ? base.slice(0, separator) : null
}

export function suppressTransientProxyError(
  pendingTerminals: Set<string>,
  event: PtyRuntimeEvent,
  currentModel: string | null | undefined,
  proxyProviders: readonly string[],
): boolean {
  const terminalId = event.terminalId
  const recovered =
    event.kind === "modelChange" ||
    event.kind === "retryFallbackApplied" ||
    (event.kind === "activity" && (event.activity === "thinking" || event.activity === "idle"))
  if (recovered) {
    pendingTerminals.delete(terminalId)
    return false
  }

  const failed =
    event.kind === "modelError" ||
    event.kind === "runtimeError" ||
    (event.kind === "activity" && event.activity === "error")
  if (!failed) return false

  const provider = providerFromSelector(event.model ?? currentModel)
  if (!provider || !proxyProviders.includes(provider)) {
    pendingTerminals.delete(terminalId)
    return false
  }
  if (pendingTerminals.has(terminalId)) return false
  pendingTerminals.add(terminalId)
  return true
}

export function applyRuntimeEventToTab(tab: TerminalTab, event: PtyRuntimeEvent): TerminalTab {
  if (tab.id !== event.terminalId) return tab

  return {
    ...tab,
    currentModel: event.model ?? tab.currentModel,
    currentModelRole:
      event.model === null
        ? tab.currentModelRole
        : event.kind === "retryFallbackApplied"
          ? (event.fallbackRole ?? event.modelRole ?? tab.currentModelRole)
          : (event.modelRole ?? "default"),
    currentThinking: event.thinkingLevel ?? tab.currentThinking,
    currentThinkingConfigured: event.configuredThinkingLevel ?? tab.currentThinkingConfigured,
    activity: event.activity ?? tab.activity,
  }
}

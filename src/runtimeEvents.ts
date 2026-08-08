import type { PtyRuntimeEvent, TerminalTab } from "./types"

export type RuntimeEventFeedback =
  | { kind: "fallback"; model: string }
  | { kind: "error"; message: string }
  | null

export function runtimeEventFeedback(event: PtyRuntimeEvent): RuntimeEventFeedback {
  if (event.kind === "retryFallbackApplied") {
    const selector = event.fallbackTo ?? event.model
    if (selector) {
      const modelSelector = selector.split(":")[0]
      return {
        kind: "fallback",
        model: modelSelector.split("/").at(-1) ?? modelSelector,
      }
    }
  }
  if (event.errorMessage) {
    return { kind: "error", message: event.errorMessage }
  }
  return null
}

export function applyRuntimeEventToTab(
  tab: TerminalTab,
  event: PtyRuntimeEvent,
): TerminalTab {
  if (tab.id !== event.terminalId) return tab

  return {
    ...tab,
    currentModel: event.model ?? tab.currentModel,
    currentModelRole:
      event.model === null
        ? tab.currentModelRole
        : event.kind === "retryFallbackApplied"
          ? "fallback"
          : (event.modelRole ?? "default"),
    currentThinking: event.thinkingLevel ?? tab.currentThinking,
    currentThinkingConfigured:
      event.configuredThinkingLevel ?? tab.currentThinkingConfigured,
    activity: event.activity ?? tab.activity,
  }
}

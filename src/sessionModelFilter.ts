import type { SessionSummary } from "./types"

// null selects all models; an empty key groups absent/empty recorded metadata.
export function sessionModelKey(session: Pick<SessionSummary, "model">): string {
  return session.model ?? ""
}

export function sessionModelOptions(
  sessions: SessionSummary[],
  selectedModel: string | null,
): string[] {
  const models = new Set(sessions.map(sessionModelKey))
  // Polling/removal must not silently change an active filter to "all".
  if (selectedModel !== null) models.add(selectedModel)
  return [...models].sort()
}

export function filterSessionsByModel(
  sessions: SessionSummary[],
  selectedModel: string | null,
): SessionSummary[] {
  return selectedModel === null
    ? sessions
    : sessions.filter((session) => sessionModelKey(session) === selectedModel)
}

import type { CodexSessionSummary } from "./types"

/** Search discovered, displayed metadata only; never read a transcript or change its identity. */
export function filterCodexSessions(
  sessions: CodexSessionSummary[],
  query: string,
): CodexSessionSummary[] {
  const normalized = query.trim().normalize("NFC").toLowerCase()
  if (!normalized) return sessions
  return sessions.filter((session) =>
    [session.title, session.cwd, session.model ?? "", session.preview].some((value) =>
      value.normalize("NFC").toLowerCase().includes(normalized),
    ),
  )
}

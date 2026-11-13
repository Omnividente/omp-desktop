import type { RuntimeIncident } from "./runtimeIncidents"

/** Search the row's diagnostic text, not hidden metadata or raw terminal output. */
export function matchesIncidentSearch(
  incident: RuntimeIncident,
  currentTerminalLabel: string | undefined,
  query: string,
): boolean {
  const needle = query.trim().normalize("NFC").toLocaleLowerCase()
  if (!needle) return true
  const fields = [
    incident.terminalId,
    currentTerminalLabel ?? incident.terminalLabel,
    incident.role,
    incident.reason,
    ...(incident.kind === "fallback"
      ? [incident.fallbackFrom, incident.fallbackTo ?? incident.model]
      : []),
  ]
  return fields.some((value) => value?.normalize("NFC").toLocaleLowerCase().includes(needle))
}

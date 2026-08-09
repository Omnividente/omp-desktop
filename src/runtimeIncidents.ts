import type { PtyRuntimeEventKind } from "./types"

export const MAX_RUNTIME_INCIDENTS = 100

export type RuntimeIncidentKind = "fallback" | "modelError" | "runtimeError"
export type RuntimeIncidentStatus = "active" | "resolved"
export type RuntimeHealthStatus = "normal" | "fallback" | "error"
export type RuntimeIncidentResolutionReason =
  "recovered" | "recoveredThroughFallback" | "primaryRestored" | "terminalEnded"

type RuntimeIncidentSourceKind = Extract<
  PtyRuntimeEventKind,
  "activity" | "modelChange" | "retryFallbackApplied" | "modelError" | "runtimeError"
>

export interface RuntimeIncident {
  id: string
  groupingKey: string
  terminalId: string
  terminalLabel: string | null
  kind: RuntimeIncidentKind
  sourceKind: RuntimeIncidentSourceKind
  status: RuntimeIncidentStatus
  role: string | null
  model: string | null
  modelRole: string | null
  fallbackRole: string | null
  fallbackFrom: string | null
  fallbackTo: string | null
  reason: string | null
  count: number
  firstSeenAt: number
  lastSeenAt: number
  resolvedAt: number | null
  resolutionReason: RuntimeIncidentResolutionReason | null
}

export interface RuntimeIncidentState {
  incidents: RuntimeIncident[]
  sequence: number
}

type RuntimeEvent = {
  terminalId: string
  kind: PtyRuntimeEventKind
  model: string | null
  modelRole: string | null
  activity: "idle" | "thinking" | "error" | null
  errorMessage: string | null
  fallbackFrom: string | null
  fallbackTo: string | null
  fallbackRole: string | null
  resolvedModelIsFallback: boolean | null
}

type NewIncident = Omit<
  RuntimeIncident,
  | "id"
  | "groupingKey"
  | "status"
  | "count"
  | "firstSeenAt"
  | "lastSeenAt"
  | "resolvedAt"
  | "resolutionReason"
>

const RUNTIME_EVENT_KINDS: ReadonlySet<string> = new Set<PtyRuntimeEventKind>([
  "activity",
  "runtimeError",
  "modelChange",
  "retryFallbackApplied",
  "thinkingLevelChange",
  "modelError",
])

export function createRuntimeIncidentState(_now: number): RuntimeIncidentState {
  return { incidents: [], sequence: 0 }
}

export function applyRuntimeIncidentEvent(
  state: RuntimeIncidentState,
  value: unknown,
  now: number,
  terminalLabel?: string | null,
): RuntimeIncidentState {
  const event = parseRuntimeEvent(value)
  if (!event || event.kind === "thinkingLevelChange") return state

  const label = nonEmptyLabel(terminalLabel)

  if (event.kind === "retryFallbackApplied") {
    const next = resolveErrors(state, event.terminalId, "recoveredThroughFallback", now)
    return upsertIncident(
      next,
      {
        terminalId: event.terminalId,
        terminalLabel: label,
        kind: "fallback",
        sourceKind: event.kind,
        role: normalizeFallbackRole(event.fallbackRole ?? event.modelRole),
        model: event.model,
        modelRole: event.modelRole,
        fallbackRole: event.fallbackRole,
        fallbackFrom: event.fallbackFrom,
        fallbackTo: event.fallbackTo,
        reason: hasReason(event.errorMessage) ? event.errorMessage : null,
      },
      now,
    )
  }

  if (event.kind === "modelError" || event.kind === "runtimeError") {
    const reason = hasReason(event.errorMessage) ? event.errorMessage : null
    if (reason === null && event.activity !== "error") return state

    return upsertDetailedError(
      state,
      {
        terminalId: event.terminalId,
        terminalLabel: label,
        kind: event.kind,
        sourceKind: event.kind,
        role: normalizeFallbackRole(event.modelRole ?? event.fallbackRole),
        model: event.model,
        modelRole: event.modelRole,
        fallbackRole: event.fallbackRole,
        fallbackFrom: event.fallbackFrom,
        fallbackTo: event.fallbackTo,
        reason,
      },
      now,
    )
  }

  if (event.kind === "activity") {
    if (event.activity === "error") {
      const alreadyActive = state.incidents.some(
        (incident) =>
          incident.terminalId === event.terminalId &&
          incident.status === "active" &&
          (incident.kind === "modelError" || incident.kind === "runtimeError"),
      )
      if (alreadyActive) return state
      return upsertIncident(
        state,
        {
          terminalId: event.terminalId,
          terminalLabel: label,
          kind: "runtimeError",
          sourceKind: event.kind,
          role: null,
          model: event.model,
          modelRole: event.modelRole,
          fallbackRole: event.fallbackRole,
          fallbackFrom: event.fallbackFrom,
          fallbackTo: event.fallbackTo,
          reason: null,
        },
        now,
      )
    }
    if (event.activity !== "thinking" && event.activity !== "idle") return state
    return resolveErrors(state, event.terminalId, "recovered", now)
  }

  if (event.kind !== "modelChange") return state

  const fallbackState =
    event.resolvedModelIsFallback ?? (event.modelRole === "fallback" ? true : null)
  if (fallbackState === true) {
    let next = resolveErrors(state, event.terminalId, "recoveredThroughFallback", now)
    const existing = findMatchingRetryFallback(next, event)
    const role = normalizeFallbackRole(existing?.role ?? event.fallbackRole ?? event.modelRole)

    if (!existing) {
      next = upsertIncident(
        next,
        {
          terminalId: event.terminalId,
          terminalLabel: label,
          kind: "fallback",
          sourceKind: event.kind,
          role,
          model: event.model,
          modelRole: event.modelRole,
          fallbackRole: event.fallbackRole,
          fallbackFrom: event.fallbackFrom,
          fallbackTo: event.fallbackTo ?? event.model,
          reason: hasReason(event.errorMessage) ? event.errorMessage : null,
        },
        now,
      )
    }
    return next
  }

  const role = normalizeFallbackRole(event.fallbackRole ?? event.modelRole)
  if (fallbackState === false) {
    return resolveFallbacks(state, event.terminalId, role, "primaryRestored", now)
  }

  if (event.modelRole === null || event.model === null) return state
  if (findMatchingActiveFallback(state, event)) return state
  return resolveFallbacks(state, event.terminalId, role, "primaryRestored", now)
}

export function endRuntimeIncidentTerminal(
  state: RuntimeIncidentState,
  terminalId: string,
  now: number,
): RuntimeIncidentState {
  return resolveIncidents(
    state,
    (incident) => incident.terminalId === terminalId,
    "terminalEnded",
    now,
  )
}

export function clearResolvedRuntimeIncidents(
  state: RuntimeIncidentState,
  _now: number,
): RuntimeIncidentState {
  const incidents = state.incidents.filter((incident) => incident.status === "active")
  return incidents.length === state.incidents.length ? state : { ...state, incidents }
}

export function runtimeHealthStatus(
  state: RuntimeIncidentState,
  terminalId: string,
): RuntimeHealthStatus {
  let fallbackActive = false
  for (const incident of state.incidents) {
    if (incident.terminalId !== terminalId || incident.status !== "active") continue
    if (incident.kind === "modelError" || incident.kind === "runtimeError") return "error"
    fallbackActive = true
  }
  return fallbackActive ? "fallback" : "normal"
}

export function activeRuntimeTerminalCount(state: RuntimeIncidentState): number {
  const activeTerminalIds = new Set<string>()
  for (const incident of state.incidents) {
    if (incident.status === "active") activeTerminalIds.add(incident.terminalId)
  }
  return activeTerminalIds.size
}

export function runtimeIncidentsLatestFirst(incidents: RuntimeIncident[]): RuntimeIncident[] {
  return [...incidents].sort(
    (left, right) =>
      right.lastSeenAt - left.lastSeenAt ||
      right.firstSeenAt - left.firstSeenAt ||
      sequenceFromId(right.id) - sequenceFromId(left.id),
  )
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.terminalId !== "string" || record.terminalId.trim().length === 0) return null
  if (typeof record.kind !== "string" || !RUNTIME_EVENT_KINDS.has(record.kind)) return null

  const activity =
    record.activity === "idle" || record.activity === "thinking" || record.activity === "error"
      ? record.activity
      : null
  const resolvedModelIsFallback =
    typeof record.resolvedModelIsFallback === "boolean" ? record.resolvedModelIsFallback : null

  return {
    terminalId: record.terminalId,
    kind: record.kind as PtyRuntimeEventKind,
    model: nullableString(record.model),
    modelRole: nullableString(record.modelRole),
    activity,
    errorMessage: nullableString(record.errorMessage),
    fallbackFrom: nullableString(record.fallbackFrom),
    fallbackTo: nullableString(record.fallbackTo),
    fallbackRole: nullableString(record.fallbackRole),
    resolvedModelIsFallback,
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function nonEmptyLabel(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function hasReason(reason: string | null): reason is string {
  return typeof reason === "string" && reason.trim().length > 0
}

function groupingKey(incident: NewIncident): string {
  return JSON.stringify([
    "runtime-incident",
    incident.terminalId,
    incident.sourceKind,
    incident.model,
    incident.modelRole,
    incident.fallbackRole,
    incident.fallbackFrom,
    incident.fallbackTo,
    incident.reason,
  ])
}

function upsertDetailedError(
  state: RuntimeIncidentState,
  incident: NewIncident,
  now: number,
): RuntimeIncidentState {
  const genericIndex = state.incidents.findIndex(
    (candidate) =>
      candidate.terminalId === incident.terminalId &&
      candidate.status === "active" &&
      candidate.sourceKind === "activity" &&
      candidate.reason === null &&
      (candidate.kind === "modelError" || candidate.kind === "runtimeError"),
  )
  if (genericIndex < 0) return upsertIncident(state, incident, now)

  const key = groupingKey(incident)
  const matchingDetailed = state.incidents.findIndex(
    (candidate, index) => index !== genericIndex && candidate.groupingKey === key,
  )
  if (matchingDetailed >= 0) {
    return upsertIncident(
      {
        ...state,
        incidents: state.incidents.filter((_, index) => index !== genericIndex),
      },
      incident,
      now,
    )
  }

  const generic = state.incidents[genericIndex]
  const incidents = [...state.incidents]
  incidents[genericIndex] = {
    ...generic,
    ...incident,
    groupingKey: key,
    terminalLabel: incident.terminalLabel ?? generic.terminalLabel,
    status: "active",
    lastSeenAt: now,
    resolvedAt: null,
    resolutionReason: null,
  }
  return { ...state, incidents }
}

function upsertIncident(
  state: RuntimeIncidentState,
  incident: NewIncident,
  now: number,
): RuntimeIncidentState {
  const key = groupingKey(incident)
  const index = state.incidents.findIndex((candidate) => candidate.groupingKey === key)

  if (index >= 0) {
    const current = state.incidents[index]
    const incidents = [...state.incidents]
    incidents[index] = {
      ...current,
      terminalLabel: incident.terminalLabel ?? current.terminalLabel,
      status: "active",
      count: current.count + 1,
      lastSeenAt: now,
      resolvedAt: null,
      resolutionReason: null,
    }
    return { ...state, incidents }
  }

  const sequence = state.sequence + 1
  const next: RuntimeIncident = {
    ...incident,
    id: `runtime-incident-${sequence}`,
    groupingKey: key,
    status: "active",
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    resolvedAt: null,
    resolutionReason: null,
  }
  return {
    ...state,
    incidents: enforceIncidentBound([...state.incidents, next]),
    sequence,
  }
}

function enforceIncidentBound(incidents: RuntimeIncident[]): RuntimeIncident[] {
  if (incidents.length <= MAX_RUNTIME_INCIDENTS) return incidents

  const resolved = incidents.filter((incident) => incident.status === "resolved")
  let candidates = resolved
  if (candidates.length === 0) {
    const activePerTerminal = new Map<string, number>()
    for (const incident of incidents) {
      activePerTerminal.set(
        incident.terminalId,
        (activePerTerminal.get(incident.terminalId) ?? 0) + 1,
      )
    }
    candidates = incidents.filter(
      (incident) => (activePerTerminal.get(incident.terminalId) ?? 0) > 1,
    )
    if (candidates.length === 0) candidates = incidents
  }

  const oldest = candidates.reduce((current, candidate) => {
    const currentTime =
      current.status === "resolved"
        ? (current.resolvedAt ?? current.lastSeenAt)
        : current.lastSeenAt
    const candidateTime =
      candidate.status === "resolved"
        ? (candidate.resolvedAt ?? candidate.lastSeenAt)
        : candidate.lastSeenAt
    if (candidateTime !== currentTime) return candidateTime < currentTime ? candidate : current
    if (candidate.firstSeenAt !== current.firstSeenAt) {
      return candidate.firstSeenAt < current.firstSeenAt ? candidate : current
    }
    return sequenceFromId(candidate.id) < sequenceFromId(current.id) ? candidate : current
  })
  return incidents.filter((incident) => incident.id !== oldest.id)
}

function sequenceFromId(id: string): number {
  const sequence = Number(id.slice(id.lastIndexOf("-") + 1))
  return Number.isFinite(sequence) ? sequence : 0
}

function resolveErrors(
  state: RuntimeIncidentState,
  terminalId: string,
  reason: RuntimeIncidentResolutionReason,
  now: number,
): RuntimeIncidentState {
  return resolveIncidents(
    state,
    (incident) =>
      incident.terminalId === terminalId &&
      (incident.kind === "modelError" || incident.kind === "runtimeError"),
    reason,
    now,
  )
}

function resolveFallbacks(
  state: RuntimeIncidentState,
  terminalId: string,
  role: string | null,
  reason: RuntimeIncidentResolutionReason,
  now: number,
): RuntimeIncidentState {
  return resolveIncidents(
    state,
    (incident) =>
      incident.terminalId === terminalId &&
      incident.kind === "fallback" &&
      (role === null ? incident.role === null : incident.role === role || incident.role === null),
    reason,
    now,
  )
}

function resolveIncidents(
  state: RuntimeIncidentState,
  matches: (incident: RuntimeIncident) => boolean,
  reason: RuntimeIncidentResolutionReason,
  now: number,
): RuntimeIncidentState {
  let changed = false
  const incidents = state.incidents.map((incident) => {
    if (incident.status !== "active" || !matches(incident)) return incident
    changed = true
    return {
      ...incident,
      status: "resolved" as const,
      resolvedAt: now,
      resolutionReason: reason,
    }
  })
  return changed ? { ...state, incidents } : state
}

function findMatchingRetryFallback(
  state: RuntimeIncidentState,
  event: RuntimeEvent,
): RuntimeIncident | null {
  return (
    state.incidents.find(
      (incident) =>
        incident.sourceKind === "retryFallbackApplied" && fallbackIncidentMatches(incident, event),
    ) ?? null
  )
}

function findMatchingActiveFallback(
  state: RuntimeIncidentState,
  event: RuntimeEvent,
): RuntimeIncident | null {
  return state.incidents.find((incident) => fallbackIncidentMatches(incident, event)) ?? null
}

function fallbackIncidentMatches(incident: RuntimeIncident, event: RuntimeEvent): boolean {
  if (
    incident.status !== "active" ||
    incident.kind !== "fallback" ||
    incident.terminalId !== event.terminalId
  ) {
    return false
  }

  const eventRole = normalizeFallbackRole(event.fallbackRole ?? event.modelRole)
  const roleIsExplicit =
    event.fallbackRole !== null || (event.modelRole !== null && event.modelRole !== "fallback")
  const roleMatches = !roleIsExplicit || incident.role === eventRole || incident.role === null
  const fromMatches = event.fallbackFrom === null || incident.fallbackFrom === event.fallbackFrom
  const targetMatches =
    event.model !== null
      ? incident.model === event.model
      : event.fallbackTo !== null
        ? incident.fallbackTo === event.fallbackTo
        : true
  return roleMatches && fromMatches && targetMatches
}

function normalizeFallbackRole(role: string | null): string | null {
  return role === "fallback" ? null : role
}

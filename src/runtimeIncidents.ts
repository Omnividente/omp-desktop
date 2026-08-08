import type { PtyRuntimeEventKind } from "./types"

export const MAX_RUNTIME_INCIDENTS = 100

export type RuntimeIncidentKind = "fallback" | "modelError" | "runtimeError"
export type RuntimeIncidentStatus = "active" | "resolved"
export type RuntimeHealthStatus = "normal" | "fallback" | "error"
export type RuntimeIncidentResolutionReason =
  "recovered" | "recoveredThroughFallback" | "primaryRestored" | "terminalEnded"

type RuntimeIncidentSourceKind = Extract<
  PtyRuntimeEventKind,
  "modelChange" | "retryFallbackApplied" | "modelError" | "runtimeError"
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

export interface TerminalRuntimeHealth {
  errorActive: boolean
  fallbackUnknownRole: boolean
  fallbackRoles: string[]
}

export interface RuntimeIncidentState {
  incidents: RuntimeIncident[]
  healthByTerminal: Record<string, TerminalRuntimeHealth>
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

const EMPTY_HEALTH: TerminalRuntimeHealth = {
  errorActive: false,
  fallbackUnknownRole: false,
  fallbackRoles: [],
}

export function createRuntimeIncidentState(_now: number): RuntimeIncidentState {
  return { incidents: [], healthByTerminal: {}, sequence: 0 }
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
    let next = resolveErrors(state, event.terminalId, "recoveredThroughFallback", now)
    next = upsertIncident(
      next,
      {
        terminalId: event.terminalId,
        terminalLabel: label,
        kind: "fallback",
        sourceKind: event.kind,
        role: event.fallbackRole,
        model: event.model,
        modelRole: event.modelRole,
        fallbackRole: event.fallbackRole,
        fallbackFrom: event.fallbackFrom,
        fallbackTo: event.fallbackTo,
        reason: event.errorMessage,
      },
      now,
    )
    return updateHealth(next, event.terminalId, (health) => ({
      ...addFallbackRole(health, event.fallbackRole),
      errorActive: false,
    }))
  }

  if (event.kind === "modelError" || event.kind === "runtimeError") {
    if (!hasReason(event.errorMessage)) return state

    let next = upsertIncident(
      state,
      {
        terminalId: event.terminalId,
        terminalLabel: label,
        kind: event.kind,
        sourceKind: event.kind,
        role: event.modelRole ?? event.fallbackRole,
        model: event.model,
        modelRole: event.modelRole,
        fallbackRole: event.fallbackRole,
        fallbackFrom: event.fallbackFrom,
        fallbackTo: event.fallbackTo,
        reason: event.errorMessage,
      },
      now,
    )
    next = updateHealth(next, event.terminalId, (health) => ({
      ...health,
      errorActive: true,
    }))
    return next
  }

  if (event.kind === "activity") {
    if (event.activity !== "thinking" && event.activity !== "idle") return state
    const next = resolveErrors(state, event.terminalId, "recovered", now)
    return updateHealth(next, event.terminalId, (health) => ({
      ...health,
      errorActive: false,
    }))
  }

  if (event.kind !== "modelChange") return state

  let next = resolveErrors(state, event.terminalId, "recovered", now)
  next = updateHealth(next, event.terminalId, (health) => ({
    ...health,
    errorActive: false,
  }))

  if (event.resolvedModelIsFallback === true) {
    const existing = findMatchingRetryFallback(next, event)
    const role = existing?.role ?? event.fallbackRole ?? event.modelRole

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
          reason: event.errorMessage,
        },
        now,
      )
    }

    return updateHealth(next, event.terminalId, (health) => addFallbackRole(health, role))
  }

  if (event.resolvedModelIsFallback === false) {
    const role = event.fallbackRole ?? event.modelRole
    next = resolveFallbacks(next, event.terminalId, role, "primaryRestored", now)
    return updateHealth(next, event.terminalId, (health) => removeFallbackRole(health, role))
  }

  return next
}

export function endRuntimeIncidentTerminal(
  state: RuntimeIncidentState,
  terminalId: string,
  now: number,
): RuntimeIncidentState {
  let next = resolveIncidents(
    state,
    (incident) => incident.terminalId === terminalId,
    "terminalEnded",
    now,
  )
  if (!(terminalId in next.healthByTerminal)) return next

  const healthByTerminal = { ...next.healthByTerminal }
  delete healthByTerminal[terminalId]
  next = { ...next, healthByTerminal }
  return next
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
  const health = state.healthByTerminal[terminalId]
  if (!health) return "normal"
  if (health.errorActive) return "error"
  if (health.fallbackUnknownRole || health.fallbackRoles.length > 0) return "fallback"
  return "normal"
}

export function activeRuntimeTerminalCount(state: RuntimeIncidentState): number {
  return Object.keys(state.healthByTerminal).reduce(
    (count, terminalId) =>
      runtimeHealthStatus(state, terminalId) === "normal" ? count : count + 1,
    0,
  )
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
  const candidates = resolved.length > 0 ? resolved : incidents
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
      (role === null || incident.role === role),
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
  const eventRole = event.fallbackRole ?? event.modelRole
  return (
    state.incidents.find((incident) => {
      if (
        incident.status !== "active" ||
        incident.kind !== "fallback" ||
        incident.sourceKind !== "retryFallbackApplied" ||
        incident.terminalId !== event.terminalId
      ) {
        return false
      }

      const roleMatches =
        event.fallbackRole !== null || (event.modelRole !== null && event.modelRole !== "fallback")
          ? incident.role === eventRole
          : true
      const fromMatches =
        event.fallbackFrom === null || incident.fallbackFrom === event.fallbackFrom
      const targetMatches =
        event.model !== null
          ? incident.model === event.model
          : event.fallbackTo !== null
            ? incident.fallbackTo === event.fallbackTo
            : true
      return roleMatches && fromMatches && targetMatches
    }) ?? null
  )
}

function updateHealth(
  state: RuntimeIncidentState,
  terminalId: string,
  update: (health: TerminalRuntimeHealth) => TerminalRuntimeHealth,
): RuntimeIncidentState {
  const current = state.healthByTerminal[terminalId] ?? EMPTY_HEALTH
  const next = update({
    errorActive: current.errorActive,
    fallbackUnknownRole: current.fallbackUnknownRole,
    fallbackRoles: [...current.fallbackRoles],
  })
  const isNormal = !next.errorActive && !next.fallbackUnknownRole && next.fallbackRoles.length === 0

  if (isNormal && !(terminalId in state.healthByTerminal)) return state
  if (isNormal) {
    const healthByTerminal = { ...state.healthByTerminal }
    delete healthByTerminal[terminalId]
    return { ...state, healthByTerminal }
  }

  if (
    current.errorActive === next.errorActive &&
    current.fallbackUnknownRole === next.fallbackUnknownRole &&
    current.fallbackRoles.length === next.fallbackRoles.length &&
    current.fallbackRoles.every((role, index) => role === next.fallbackRoles[index])
  ) {
    return state
  }
  return {
    ...state,
    healthByTerminal: { ...state.healthByTerminal, [terminalId]: next },
  }
}

function addFallbackRole(
  health: TerminalRuntimeHealth,
  role: string | null,
): TerminalRuntimeHealth {
  if (role === null) return { ...health, fallbackUnknownRole: true }
  if (health.fallbackRoles.includes(role)) return health
  return { ...health, fallbackRoles: [...health.fallbackRoles, role] }
}

function removeFallbackRole(
  health: TerminalRuntimeHealth,
  role: string | null,
): TerminalRuntimeHealth {
  if (role === null) {
    return { ...health, fallbackUnknownRole: false, fallbackRoles: [] }
  }
  return {
    ...health,
    fallbackRoles: health.fallbackRoles.filter((candidate) => candidate !== role),
  }
}

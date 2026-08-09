import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import {
  runtimeIncidentsLatestFirst,
  type RuntimeIncident,
  type RuntimeIncidentResolutionReason,
} from "./runtimeIncidents"
import type { TerminalTab } from "./types"

interface IncidentCenterProps {
  incidents: RuntimeIncident[]
  language: Lang
  tabs: TerminalTab[]
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onClearResolved: () => void
  onClose: () => void
  onFocusTerminal: (terminalId: string) => void
}

type IncidentFilter = "active" | "all"

export function IncidentCenter({
  incidents,
  language,
  tabs,
  returnFocusRef,
  onClearResolved,
  onClose,
  onFocusTerminal,
}: IncidentCenterProps) {
  const [filter, setFilter] = useState<IncidentFilter>("active")
  const initialFocusRef = useRef<HTMLButtonElement>(null)
  const restoreTriggerFocusRef = useRef(true)
  const latestFirst = useMemo(() => runtimeIncidentsLatestFirst(incidents), [incidents])
  const visibleIncidents = useMemo(
    () =>
      filter === "active"
        ? latestFirst.filter((incident) => incident.status === "active")
        : latestFirst,
    [filter, latestFirst],
  )
  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])
  const resolvedCount = incidents.filter((incident) => incident.status === "resolved").length
  const activeCount = incidents.filter((incident) => incident.status === "active").length

  useEffect(() => {
    const returnFocusTarget = returnFocusRef.current
    initialFocusRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      if (restoreTriggerFocusRef.current) {
        window.requestAnimationFrame(() => returnFocusTarget?.focus())
      }
    }
  }, [onClose, returnFocusRef])

  const focusTerminal = (terminalId: string) => {
    restoreTriggerFocusRef.current = false
    onFocusTerminal(terminalId)
    onClose()
  }

  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="incident-center-title"
        aria-modal="true"
        className="settings-panel incident-center-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-header incident-center-header">
          <div>
            <span className="eyebrow">Runtime</span>
            <h2 id="incident-center-title">{t(language, "incidentCenterTitle")}</h2>
            <small>
              {t(language, "incidentActiveSummary").replace("{count}", String(activeCount))}
            </small>
          </div>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            onClick={onClose}
            title={t(language, "close")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="incident-center-toolbar">
          <div
            aria-label={t(language, "incidentFilterLabel")}
            className="incident-filter"
            role="group"
          >
            <button
              aria-pressed={filter === "active"}
              className={filter === "active" ? "is-active" : undefined}
              onClick={() => setFilter("active")}
              ref={initialFocusRef}
              type="button"
            >
              {t(language, "incidentFilterActive")}
              <span>{activeCount}</span>
            </button>
            <button
              aria-pressed={filter === "all"}
              className={filter === "all" ? "is-active" : undefined}
              onClick={() => setFilter("all")}
              type="button"
            >
              {t(language, "incidentFilterAll")}
              <span>{incidents.length}</span>
            </button>
          </div>
          <button
            className="button secondary incident-clear-button"
            disabled={resolvedCount === 0}
            onClick={onClearResolved}
            type="button"
          >
            {t(language, "incidentClearResolved")}
          </button>
        </div>

        <div className="incident-center-scroll">
          {visibleIncidents.length === 0 ? (
            <div className="incident-empty">
              <Icon name="history" size={28} />
              <strong>
                {t(
                  language,
                  incidents.length === 0 ? "incidentNoIncidents" : "incidentNoActiveIncidents",
                )}
              </strong>
            </div>
          ) : (
            <div className="incident-list">
              {visibleIncidents.map((incident) => {
                const tab = tabById.get(incident.terminalId)
                const reasonIsLong =
                  incident.reason !== null &&
                  (incident.reason.includes("\n") || incident.reason.length > 180)
                return (
                  <article
                    className={`incident-row is-${incident.kind} is-${incident.status}`}
                    key={incident.id}
                  >
                    <header className="incident-row-header">
                      <div className="incident-terminal">
                        <Icon name="terminal" size={14} />
                        <strong>
                          {incident.terminalLabel ?? tab?.label ?? incident.terminalId}
                        </strong>
                        <code>{incident.terminalId}</code>
                      </div>
                      <div className="incident-row-badges">
                        <span className={`incident-kind is-${incident.kind}`}>
                          {incidentKindLabel(incident, language)}
                        </span>
                        <span className={`incident-status is-${incident.status}`}>
                          {t(
                            language,
                            incident.status === "active"
                              ? "incidentStatusActive"
                              : "incidentStatusResolved",
                          )}
                        </span>
                        <span
                          className="incident-count"
                          title={`${t(language, "incidentOccurrences")}: ${incident.count}`}
                        >
                          ×{incident.count}
                        </span>
                      </div>
                    </header>

                    <div className="incident-role">
                      <span>{t(language, "incidentRole")}</span>
                      <code>{incident.role ?? t(language, "incidentRoleUnknown")}</code>
                    </div>

                    {incident.kind === "fallback" && (
                      <div className="incident-transition">
                        <div>
                          <span>{t(language, "incidentFrom")}</span>
                          <code>{incident.fallbackFrom ?? "—"}</code>
                        </div>
                        <Icon name="arrow" size={15} />
                        <div>
                          <span>{t(language, "incidentTo")}</span>
                          <code>{incident.fallbackTo ?? incident.model ?? "—"}</code>
                        </div>
                      </div>
                    )}

                    {incident.reason !== null && (
                      <div className="incident-reason">
                        <span>{t(language, "incidentReason")}</span>
                        <p>{incident.reason}</p>
                        {reasonIsLong && (
                          <details>
                            <summary>{t(language, "incidentShowFullReason")}</summary>
                            <pre>{incident.reason}</pre>
                          </details>
                        )}
                      </div>
                    )}

                    <div className="incident-times">
                      <span>{t(language, "incidentFirstSeen")}</span>
                      <time dateTime={new Date(incident.firstSeenAt).toISOString()}>
                        {formatTimestamp(incident.firstSeenAt, language)}
                      </time>
                      <span>{t(language, "incidentLastSeen")}</span>
                      <time dateTime={new Date(incident.lastSeenAt).toISOString()}>
                        {formatTimestamp(incident.lastSeenAt, language)}
                      </time>
                    </div>

                    <footer className="incident-row-footer">
                      <span className="incident-resolution">
                        {incident.resolutionReason
                          ? resolutionLabel(incident.resolutionReason, language)
                          : t(language, "incidentStatusActive")}
                      </span>
                      {tab ? (
                        <button
                          className="button secondary incident-open-terminal"
                          onClick={() => focusTerminal(incident.terminalId)}
                          type="button"
                        >
                          <Icon name="terminal" size={13} />
                          {t(language, "incidentOpenTerminal")}
                        </button>
                      ) : (
                        <span className="incident-terminal-closed">
                          {t(language, "incidentTerminalClosed")}
                        </span>
                      )}
                    </footer>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function incidentKindLabel(incident: RuntimeIncident, language: Lang): string {
  if (incident.kind === "fallback") return t(language, "incidentFallback")
  return t(language, incident.kind === "modelError" ? "incidentModelError" : "incidentRuntimeError")
}

function resolutionLabel(reason: RuntimeIncidentResolutionReason, language: Lang): string {
  const labels = {
    recovered: "incidentRecovered",
    recoveredThroughFallback: "incidentRecoveredThroughFallback",
    primaryRestored: "incidentPrimaryRestored",
    terminalEnded: "incidentTerminalEnded",
  } as const
  return t(language, labels[reason])
}

function formatTimestamp(timestamp: number, language: Lang): string {
  return new Intl.DateTimeFormat(language === "en" ? "en" : "ru", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp)
}

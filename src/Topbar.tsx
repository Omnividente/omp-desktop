import type { Ref } from "react"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import { formatBytes, resourceSeverityLabel, resourceWarningCount } from "./resourceHealth"
import type { OmpUpdateInfo, ResourceHealthSnapshot, RuntimeInfo, WorkspaceSummary } from "./types"

interface TopbarProps {
  appVersion: string
  checkingUpdate: boolean
  incidentActiveTerminalCount: number
  incidentCenterOpen: boolean
  incidentTriggerRef: Ref<HTMLButtonElement>
  resourceHealth: ResourceHealthSnapshot | null
  resourceHealthOpen: boolean
  resourceTriggerRef: Ref<HTMLButtonElement>
  language: Lang
  refreshing: boolean
  runtime: RuntimeInfo
  selectedWorkspace: WorkspaceSummary | null
  updateInfo: OmpUpdateInfo | null
  onOpenIncidentCenter: () => void
  onOpenResourceHealth: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  onUpdate: () => void
}

export function Topbar({
  appVersion,
  checkingUpdate,
  incidentActiveTerminalCount,
  incidentCenterOpen,
  incidentTriggerRef,
  resourceHealth,
  resourceHealthOpen,
  resourceTriggerRef,
  language,
  refreshing,
  runtime,
  selectedWorkspace,
  updateInfo,
  onOpenIncidentCenter,
  onOpenResourceHealth,
  onOpenSettings,
  onRefresh,
  onUpdate,
}: TopbarProps) {
  const incidentLabel = t(
    language,
    incidentActiveTerminalCount > 0 ? "incidentOpenWithCount" : "incidentOpen",
  ).replace("{count}", String(incidentActiveTerminalCount))
  const resourceCount = resourceWarningCount(resourceHealth)
  const resourceLabel = resourceHealth
    ? `${resourceSeverityLabel(language, resourceHealth.severity)} · ${formatBytes(resourceHealth.memory.availableBytes)}`
    : t(language, "resourceDetails")

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="logo" size={26} />
        </span>
        <strong>OMP</strong>
        <span className="brand-product">Desktop</span>
        <span className="app-version" title={`OMP Desktop ${appVersion}`}>
          v{appVersion}
        </span>
      </div>
      <div className="topbar-context">
        <Icon name="folder" size={15} />
        <span>{selectedWorkspace?.name ?? t(language, "projectNotSelected")}</span>
        {selectedWorkspace && <small>{selectedWorkspace.path}</small>}
      </div>
      <div className="topbar-actions">
        <button
          className={`runtime-pill ${runtime.ompAvailable ? "is-ready" : "is-error"}`}
          onClick={onOpenSettings}
          type="button"
        >
          <span />
          {runtime.ompVersion ?? t(language, "notFound")}
        </button>
        {checkingUpdate && (
          <span aria-live="polite" className="update-check-pill">
            <span className="mini-loader" />
            {t(language, "updateChecking")}
          </span>
        )}
        {updateInfo?.hasUpdate && (
          <button
            className="button secondary update-pill"
            onClick={onUpdate}
            title={updateInfo.message}
            type="button"
          >
            <Icon name="spark" size={14} />
            {t(language, "updateNow")}
            {updateInfo.latestVersion ? ` ${updateInfo.latestVersion}` : ""}
          </button>
        )}
        <button
          aria-expanded={resourceHealthOpen}
          aria-haspopup="dialog"
          aria-label={resourceLabel}
          className={`icon-button resource-health-trigger is-${resourceHealth?.severity ?? "unknown"}`}
          onClick={onOpenResourceHealth}
          ref={resourceTriggerRef}
          title={resourceLabel}
          type="button"
        >
          <Icon name={resourceHealth?.severity === "ok" ? "check" : "alert"} />
          {resourceCount > 0 && (
            <span aria-hidden="true" className="resource-health-badge">
              {resourceCount}
            </span>
          )}
        </button>
        <button
          aria-expanded={incidentCenterOpen}
          aria-haspopup="dialog"
          aria-label={incidentLabel}
          className={`icon-button incident-center-trigger${incidentActiveTerminalCount > 0 ? " has-active" : ""}`}
          onClick={onOpenIncidentCenter}
          ref={incidentTriggerRef}
          title={incidentLabel}
          type="button"
        >
          <Icon name="history" />
          {incidentActiveTerminalCount > 0 && (
            <span aria-hidden="true" className="incident-center-badge">
              {incidentActiveTerminalCount > 99 ? "99+" : incidentActiveTerminalCount}
            </span>
          )}
        </button>
        <span aria-atomic="true" aria-live="polite" className="sr-only">
          {incidentActiveTerminalCount > 0
            ? incidentLabel
            : t(language, "incidentNoActiveTerminals")}
        </span>
        <button
          className={`icon-button${refreshing ? " is-spinning" : ""}`}
          disabled={refreshing}
          onClick={onRefresh}
          title={t(language, "refresh")}
          type="button"
        >
          <Icon name="refresh" />
        </button>
        <button
          className="icon-button"
          onClick={onOpenSettings}
          title={t(language, "settings")}
          type="button"
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}

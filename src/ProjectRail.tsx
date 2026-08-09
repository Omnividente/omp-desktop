import { useEffect, useRef, type FocusEvent } from "react"
import { Icon, type IconName } from "./Icon"
import { t } from "./i18n"
import { SessionList, type SessionListProps } from "./SessionList"
import type { RailMode, WorkspaceSummary } from "./types"

interface ProjectRailProps {
  autoOpen: boolean
  mode: RailMode
  modeSaving: boolean
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  sessionList: SessionListProps
  onAutoOpenChange: (open: boolean) => void
  onModeChange: (mode: RailMode) => void
  onOpenFolder: () => void
  onSelectWorkspace: (key: string) => void
}

const MODE_OPTIONS: Array<{
  mode: RailMode
  icon: IconName
  label: "railModeExpanded" | "railModeCollapsed" | "railModeAutoHide"
}> = [
  { mode: "expanded", icon: "panel", label: "railModeExpanded" },
  { mode: "collapsed", icon: "chevron", label: "railModeCollapsed" },
  { mode: "autoHide", icon: "pin", label: "railModeAutoHide" },
]

export function ProjectRail({
  autoOpen,
  mode,
  modeSaving,
  workspaces,
  selectedWorkspace,
  sessionList,
  onAutoOpenChange,
  onModeChange,
  onOpenFolder,
  onSelectWorkspace,
}: ProjectRailProps) {
  const { lang } = sessionList
  const railRef = useRef<HTMLElement>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const revealed = mode === "expanded" || (mode === "autoHide" && autoOpen)
  const compact = mode === "collapsed" || !revealed

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  const cancelAutoOpen = () => {
    if (openTimerRef.current === null) return
    window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }
  const cancelAutoClose = () => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const scheduleAutoOpen = () => {
    cancelAutoClose()
    if (mode !== "autoHide" || autoOpen) return
    cancelAutoOpen()
    const timer = window.setTimeout(() => {
      if (openTimerRef.current !== timer) return
      openTimerRef.current = null
      onAutoOpenChange(true)
    }, 220)
    openTimerRef.current = timer
  }
  const scheduleAutoClose = () => {
    cancelAutoOpen()
    if (mode !== "autoHide" || !autoOpen) return
    cancelAutoClose()
    const timer = window.setTimeout(() => {
      if (closeTimerRef.current !== timer) return
      closeTimerRef.current = null
      if (!railRef.current?.contains(document.activeElement)) onAutoOpenChange(false)
    }, 320)
    closeTimerRef.current = timer
  }
  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!railRef.current?.contains(event.relatedTarget as Node | null)) scheduleAutoClose()
  }

  return (
    <aside
      className={`project-rail is-${mode === "autoHide" ? "auto-hide" : mode}${revealed ? " is-revealed" : ""}${compact ? " is-compact" : ""}`}
      onBlur={handleBlur}
      onFocusCapture={() => {
        cancelAutoClose()
        if (mode === "autoHide") onAutoOpenChange(true)
      }}
      onMouseEnter={scheduleAutoOpen}
      onMouseLeave={scheduleAutoClose}
      ref={railRef}
    >
      <div className="rail-toolbar">
        <span className="rail-heading">{t(lang, "projects")}</span>
        <div className="rail-mode-controls" role="group" aria-label={t(lang, "railModeShortcut")}>
          {MODE_OPTIONS.map((option) => (
            <button
              aria-label={t(lang, option.label)}
              aria-pressed={mode === option.mode}
              className="rail-mode-button"
              disabled={modeSaving}
              key={option.mode}
              onClick={() => onModeChange(option.mode)}
              title={t(lang, option.label)}
              type="button"
            >
              <Icon name={option.icon} size={14} />
            </button>
          ))}
        </div>
        <button
          aria-label={t(lang, "btnOpenFolder")}
          className="rail-open-folder"
          onClick={onOpenFolder}
          title={t(lang, "btnOpenFolder")}
          type="button"
        >
          <Icon name="plus" size={16} />
        </button>
      </div>

      <nav className="project-list" aria-label={t(lang, "projects")}>
        {workspaces.map((workspace) => {
          const active = selectedWorkspace?.key === workspace.key
          return (
            <button
              aria-expanded={active && revealed}
              aria-label={`${workspace.name}, ${workspace.sessionCount} ${t(lang, "sessShort")}`}
              className={`project-item${active ? " is-active is-expanded" : ""}`}
              key={workspace.key}
              onClick={() => onSelectWorkspace(workspace.key)}
              title={`${workspace.name}\n${workspace.path}`}
              type="button"
            >
              <span className="project-glyph">
                <Icon name="folder" size={17} />
              </span>
              <span className="project-copy">
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.sessionCount} {t(lang, "sessShort")}
                </small>
              </span>
              <span aria-hidden="true" className="project-expand-marker">
                <Icon name="chevron" size={13} />
              </span>
              {workspace.pinned && <span className="pin-dot" title="pinned" />}
            </button>
          )
        })}
      </nav>

      {revealed && <SessionList {...sessionList} />}
      {revealed && (
        <button className="open-project-button" onClick={onOpenFolder} type="button">
          <Icon name="folderOpen" size={16} />
          {t(lang, "btnOpenFolder")}
        </button>
      )}
      <div className="rail-footer">
        <Icon name="command" size={15} />
        <span>Ctrl + B</span>
        <small>{t(lang, "railModeShortcut")}</small>
      </div>
    </aside>
  )
}

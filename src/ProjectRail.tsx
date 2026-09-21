import {
  useEffect,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { Icon, type IconName } from "./Icon"
import { t } from "./i18n"
import { SessionList, type SessionListProps } from "./SessionList"
import type { RailMode, WorkspaceSummary } from "./types"

interface ProjectRailProps {
  autoHidePaused: boolean
  autoOpen: boolean
  mode: RailMode
  modeSaving: boolean
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  sessionList: SessionListProps
  renamingWorkspaceKey: string | null
  workspaceNameValue: string
  workspaceBusyKey: string | null
  onAutoOpenChange: (open: boolean) => void
  onModeChange: (mode: RailMode) => void
  onOpenFolder: () => void
  onSelectWorkspace: (key: string) => void
  onStartWorkspaceRename: (workspace: WorkspaceSummary) => void
  onSubmitWorkspaceRename: (workspace: WorkspaceSummary) => void
  onWorkspaceNameChange: (value: string) => void
  onWorkspaceRenameKeyDown: (
    event: ReactKeyboardEvent<HTMLInputElement>,
    workspace: WorkspaceSummary,
  ) => void
  onRemoveWorkspace: (workspace: WorkspaceSummary) => void
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
  autoHidePaused,
  autoOpen,
  mode,
  modeSaving,
  workspaces,
  selectedWorkspace,
  sessionList,
  renamingWorkspaceKey,
  workspaceNameValue,
  workspaceBusyKey,
  onAutoOpenChange,
  onModeChange,
  onOpenFolder,
  onSelectWorkspace,
  onStartWorkspaceRename,
  onSubmitWorkspaceRename,
  onWorkspaceNameChange,
  onWorkspaceRenameKeyDown,
  onRemoveWorkspace,
}: ProjectRailProps) {
  const { lang } = sessionList
  const railRef = useRef<HTMLElement>(null)
  const openFolderRef = useRef<HTMLButtonElement>(null)
  const removalFocusRef = useRef<{ key: string; button: HTMLButtonElement } | null>(null)
  const renameFocusRef = useRef<{
    key: string
    input: HTMLInputElement
    row: HTMLElement | null
  } | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const revealed = mode === "expanded" || (mode === "autoHide" && autoOpen)
  const compact = mode === "collapsed" || !revealed

  useEffect(() => {
    if (autoHidePaused && closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [autoHidePaused])

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    const cancelRemovalFocus = (event: Event) => {
      const pending = removalFocusRef.current
      if (
        !pending ||
        event.target === pending.button ||
        pending.button.contains(event.target as Node)
      )
        return
      // Disabling/removing the initiating button may itself move focus to the body.
      if (
        event.type === "focusin" &&
        event.target === document.body &&
        (pending.button.disabled || !pending.button.isConnected)
      )
        return
      removalFocusRef.current = null
    }
    document.addEventListener("focusin", cancelRemovalFocus)
    document.addEventListener("pointerdown", cancelRemovalFocus)
    return () => {
      document.removeEventListener("focusin", cancelRemovalFocus)
      document.removeEventListener("pointerdown", cancelRemovalFocus)
    }
  }, [])

  useLayoutEffect(() => {
    const pending = removalFocusRef.current
    if (!pending || workspaces.some((workspace) => workspace.key === pending.key)) return
    removalFocusRef.current = null
    if (document.activeElement === document.body || document.activeElement === pending.button) {
      openFolderRef.current?.focus()
    }
  }, [workspaces])

  useLayoutEffect(() => {
    const pending = renameFocusRef.current
    if (!pending || (renamingWorkspaceKey === pending.key && pending.input.isConnected)) return
    renameFocusRef.current = null
    if (document.activeElement !== document.body && document.activeElement !== pending.input) return
    const target = pending.row?.isConnected
      ? pending.row.querySelector<HTMLButtonElement>(
          compact ? "button.project-item:not(:disabled)" : ".project-actions button:not(:disabled)",
        )
      : null
    ;(target ?? openFolderRef.current)?.focus({ preventScroll: true })
  })

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
    if (mode !== "autoHide" || !autoOpen || autoHidePaused) return
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
          ref={openFolderRef}
          title={t(lang, "btnOpenFolder")}
          type="button"
        >
          <Icon name="plus" size={16} />
        </button>
      </div>

      <nav className="project-list" aria-label={t(lang, "projects")}>
        {workspaces.map((workspace) => {
          const active = selectedWorkspace?.key === workspace.key
          const renaming = renamingWorkspaceKey === workspace.key
          const busy = workspaceBusyKey === workspace.key
          return (
            <div className={`project-item-row${active ? " is-active" : ""}`} key={workspace.key}>
              {renaming ? (
                <div className="project-item is-active is-renaming">
                  <span className="project-glyph">
                    <Icon name="folder" size={17} />
                  </span>
                  <span className="project-copy">
                    <input
                      aria-label={t(lang, "projectName")}
                      autoFocus
                      className="project-rename"
                      onBlur={() => onSubmitWorkspaceRename(workspace)}
                      onChange={(event) => onWorkspaceNameChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Escape" &&
                          document.activeElement === event.currentTarget
                        ) {
                          renameFocusRef.current = {
                            key: workspace.key,
                            input: event.currentTarget,
                            row: event.currentTarget.closest<HTMLElement>(".project-item-row"),
                          }
                        }
                        onWorkspaceRenameKeyDown(event, workspace)
                      }}
                      value={workspaceNameValue}
                    />
                    <small>{workspace.path}</small>
                  </span>
                </div>
              ) : (
                <button
                  aria-expanded={active && revealed}
                  aria-label={`${workspace.name}, ${workspace.sessionCount} ${t(lang, "sessShort")}`}
                  className={`project-item${active ? " is-active is-expanded" : ""}`}
                  disabled={busy}
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
              )}
              {!renaming && (
                <div className="project-actions">
                  <button
                    aria-label={t(lang, "renameProject")}
                    disabled={busy}
                    onClick={() => onStartWorkspaceRename(workspace)}
                    title={t(lang, "renameProject")}
                    type="button"
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    aria-label={t(lang, "removeProject")}
                    className="project-remove"
                    disabled={busy}
                    onClick={(event) => {
                      removalFocusRef.current =
                        document.activeElement === event.currentTarget
                          ? { key: workspace.key, button: event.currentTarget }
                          : null
                      onRemoveWorkspace(workspace)
                    }}
                    title={t(lang, "removeProject")}
                    type="button"
                  >
                    {busy ? <span className="mini-loader" /> : <Icon name="trash" size={12} />}
                  </button>
                </div>
              )}
            </div>
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

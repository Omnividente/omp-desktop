import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { SessionSummary, TerminalTab } from "./types"
import type { Lang } from "./i18n"
import { Icon } from "./Icon"
import { t } from "./i18n"
import { SessionRow } from "./SessionRow"
import { useVirtualList } from "./useVirtualList"
import {
  buildSessionTree,
  filterSessionTree,
  flattenSessionTree,
  sessionGroupExpansionIds,
  tabMatchesSession,
} from "./uiUtils"

export interface SessionListProps {
  lang: Lang
  allSessions: SessionSummary[]
  visibleSessions: SessionSummary[]
  workspaceSessionsCount: number
  search: string
  onSearchChange: (value: string) => void
  onClearSearch: () => void
  selectedSessionId: string | null
  launching: string | null
  renamingSessionId: string | null
  renameValue: string
  deletingSessionId: string | null
  tabs: TerminalTab[]
  platform: string
  onSelectSession: (session: SessionSummary) => void
  onLaunchSession: (session: SessionSummary) => void
  onNewSession: () => void
  onLoadTranscript: (session: SessionSummary) => void
  onStartRename: (session: SessionSummary) => void
  onToggleTitlePin: (session: SessionSummary) => void
  onDeleteSession: (session: SessionSummary) => void
  onSubmitRename: (session: SessionSummary) => void
  onRenameValueChange: (value: string) => void
  onRenameKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, session: SessionSummary) => void
  onOpenCodex: () => void
  onImportOmp: () => void
  onRevealWorkspace: (path: string) => void
  selectedWorkspacePath: string | null
  selectedWorkspaceName: string | null
  canLaunch: boolean
}

export function SessionList({
  allSessions,
  lang,
  visibleSessions,
  workspaceSessionsCount,
  search,
  onSearchChange,
  onClearSearch,
  selectedSessionId,
  launching,
  renamingSessionId,
  renameValue,
  deletingSessionId,
  tabs,
  platform,
  onSelectSession,
  onLaunchSession,
  onNewSession,
  onLoadTranscript,
  onStartRename,
  onToggleTitlePin,
  onDeleteSession,
  onSubmitRename,
  onRenameValueChange,
  onRenameKeyDown,
  onOpenCodex,
  onImportOmp,
  onRevealWorkspace,
  selectedWorkspacePath,
  selectedWorkspaceName,
  canLaunch,
}: SessionListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const removalFocusRef = useRef<{
    id: string
    workspace: string | null
    button: HTMLButtonElement
  } | null>(null)
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  const sessionTree = useMemo(
    () => buildSessionTree(allSessions, platform),
    [allSessions, platform],
  )
  const searchActive = search.trim().length > 0
  const filteredTree = useMemo(() => {
    if (!searchActive) return sessionTree
    return filterSessionTree(sessionTree, new Set(visibleSessions.map((session) => session.id)))
  }, [searchActive, sessionTree, visibleSessions])
  const flattenedSessions = useMemo(
    () => flattenSessionTree(filteredTree, expandedSessionIds, searchActive),
    [expandedSessionIds, filteredTree, searchActive],
  )

  useEffect(() => {
    setExpandedSessionIds(new Set())
  }, [selectedWorkspacePath])

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
    if (!pending) return
    if (pending.workspace !== selectedWorkspacePath) {
      removalFocusRef.current = null
      return
    }
    if (allSessions.some((session) => session.id === pending.id)) return
    removalFocusRef.current = null
    if (document.activeElement === document.body || document.activeElement === pending.button) {
      listRef.current?.focus({ preventScroll: true })
    }
  }, [allSessions, selectedWorkspacePath])

  useEffect(() => {
    if (!selectedSessionId) return
    const ancestors = sessionGroupExpansionIds(sessionTree, selectedSessionId)
    if (ancestors.length === 0) return
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      let changed = false
      for (const ancestor of ancestors) {
        if (next.has(ancestor)) continue
        next.add(ancestor)
        changed = true
      }
      return changed ? next : current
    })
  }, [selectedSessionId, sessionTree])

  // Session cards are fixed-height in App.css: 55px row + 2px separation.
  const { virtualItems, totalHeight } = useVirtualList(flattenedSessions, listRef, {
    estimatedRowHeight: 57,
    overscan: 8,
    getItemKey: (item) => item.session.id,
  })
  const lastVirtualItem = virtualItems.at(-1)

  const showEmpty = Boolean(selectedWorkspacePath) && flattenedSessions.length === 0

  return (
    <section className="project-sessions">
      <div className="session-header">
        <div className="session-project-row">
          <div>
            <span className="eyebrow">{t(lang, "sessions")}</span>
            <h2>{selectedWorkspaceName ?? t(lang, "noProject")}</h2>
          </div>
          <div className="session-header-actions">
            {selectedWorkspacePath && (
              <>
                <button
                  className="icon-button compact"
                  onClick={onOpenCodex}
                  title={t(lang, "importCodex")}
                  type="button"
                >
                  <Icon name="history" size={15} />
                </button>
                <button
                  className="icon-button compact"
                  onClick={onImportOmp}
                  title={t(lang, "importSession")}
                  type="button"
                >
                  <Icon name="plus" size={15} />
                </button>
                <button
                  className="icon-button compact"
                  onClick={() => onRevealWorkspace(selectedWorkspacePath)}
                  title={t(lang, "showInExplorer")}
                  type="button"
                >
                  <Icon name="external" size={15} />
                </button>
              </>
            )}
          </div>
        </div>
        <button
          className="button primary new-session-button"
          disabled={!selectedWorkspacePath || launching !== null || !canLaunch}
          onClick={onNewSession}
          type="button"
        >
          <Icon name="plus" size={16} />
          {launching === "new" ? t(lang, "launching") : t(lang, "btnNewSession")}
        </button>
        <label className="search-box">
          <Icon name="search" size={15} />
          <input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t(lang, "searchSessions")}
            value={search}
          />
          {search && (
            <button onClick={onClearSearch} title={t(lang, "clearSearch")} type="button">
              <Icon name="close" size={13} />
            </button>
          )}
        </label>
      </div>

      <div
        ref={listRef}
        className="session-list"
        tabIndex={-1}
        role="region"
        aria-label={t(lang, "sessions")}
      >
        {flattenedSessions.length > 0 && (
          <>
            <div style={{ height: virtualItems[0]?.offset ?? 0 }} aria-hidden="true" />
            {virtualItems.map((vi) => {
              const session = vi.item.session
              const selected = session.id === selectedSessionId
              const busy = launching === session.id
              const renaming = session.id === renamingSessionId
              const sessionTab = tabs.find((tab) => tabMatchesSession(tab, session, platform))
              const runningTab = tabs.find(
                (tab) => tab.status === "running" && tabMatchesSession(tab, session, platform),
              )
              const sessionOpen = Boolean(sessionTab)
              const sessionRunning = Boolean(runningTab)
              const sessionThinking = runningTab?.activity === "thinking"
              const deleting = deletingSessionId === session.id
              const launchDisabled = deletingSessionId !== null || launching !== null || !canLaunch

              const submit = () => onSubmitRename(session)
              const keyDown = (e: ReactKeyboardEvent<HTMLInputElement>) =>
                onRenameKeyDown(e, session)

              return (
                <div key={session.id} style={{ height: vi.height, display: "flow-root" }}>
                  <SessionRow
                    busy={busy}
                    actionsDisabled={deletingSessionId !== null}
                    childrenExpanded={vi.item.expanded}
                    depth={vi.item.depth}
                    deleting={deleting}
                    lang={lang}
                    launchDisabled={launchDisabled}
                    hasChildren={vi.item.hasChildren}
                    onDelete={(e) => {
                      e.stopPropagation()
                      removalFocusRef.current =
                        e.currentTarget instanceof HTMLButtonElement &&
                        document.activeElement === e.currentTarget
                          ? {
                              id: session.id,
                              workspace: selectedWorkspacePath,
                              button: e.currentTarget,
                            }
                          : null
                      onDeleteSession(session)
                    }}
                    onDoubleLaunch={() => {
                      if (deletingSessionId === null) onLaunchSession(session)
                    }}
                    onKeySelect={(event) => {
                      if (renaming) return
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onSelectSession(session)
                      }
                    }}
                    onToggleChildren={() => {
                      setExpandedSessionIds((current) => {
                        const next = new Set(current)
                        if (next.has(session.id)) next.delete(session.id)
                        else next.add(session.id)
                        return next
                      })
                    }}
                    onLaunch={() => onLaunchSession(session)}
                    onRenameChange={onRenameValueChange}
                    onRenameKeyDown={keyDown}
                    onSelect={() => onSelectSession(session)}
                    onStartRename={(e) => {
                      e.stopPropagation()
                      onStartRename(session)
                    }}
                    onSubmitRename={submit}
                    onToggleTitlePin={(event) => {
                      event.stopPropagation()
                      onToggleTitlePin(session)
                    }}
                    onTranscript={(event) => {
                      event.stopPropagation()
                      onLoadTranscript(session)
                    }}
                    renameValue={renameValue}
                    renaming={renaming}
                    selected={selected}
                    session={session}
                    sessionOpen={sessionOpen}
                    sessionRunning={sessionRunning}
                    sessionThinking={sessionThinking}
                  />
                </div>
              )
            })}
            <div
              aria-hidden="true"
              style={{
                height: Math.max(
                  0,
                  totalHeight -
                    (lastVirtualItem ? lastVirtualItem.offset + lastVirtualItem.height : 0),
                ),
              }}
            />
          </>
        )}

        {showEmpty && (
          <div className="sidebar-empty">
            <Icon name={search ? "search" : "history"} />
            <strong>{search ? t(lang, "nothingFound") : t(lang, "historyEmpty")}</strong>
            <span>{search ? t(lang, "tryAnotherQuery") : t(lang, "createFirstSession")}</span>
          </div>
        )}
      </div>

      <div className="session-footer">
        <span>
          {workspaceSessionsCount} {t(lang, "sessions").toLowerCase()}
        </span>
        <small>{t(lang, "jsonlNative")}</small>
      </div>
    </section>
  )
}

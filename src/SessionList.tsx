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
  type FlattenedSessionTreeItem,
  buildSessionTree,
  filterSessionTree,
  flattenSessionTree,
  sessionGroupExpansionIds,
  tabMatchesSession,
} from "./uiUtils"

const sessionItemKey = (item: FlattenedSessionTreeItem): string => item.session.id

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
  onCopySession?: (session: SessionSummary) => void
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
  onCopySession,
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sessionRowsRef = useRef(new Map<string, HTMLDivElement>())
  const searchSelectionRef = useRef<{
    id: string
    workspace: string | null
    origin: HTMLElement
    restoreFocus: boolean
  } | null>(null)
  const actionFocusRef = useRef<{
    id: string
    workspace: string | null
    kind: "remove" | "pin" | "rename" | "renamed"
    origin: Element
    target: HTMLElement | null
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
    const cancelActionFocus = (event: Event) => {
      const selection = searchSelectionRef.current
      if (
        selection &&
        event.target !== selection.origin &&
        !selection.origin.contains(event.target as Node) &&
        !(
          event.type === "focusin" &&
          event.target === document.body &&
          !selection.origin.isConnected
        )
      ) {
        searchSelectionRef.current = null
      }
      const pending = actionFocusRef.current
      if (
        !pending ||
        event.target === pending.origin ||
        pending.origin.contains(event.target as Node)
      )
        return
      // Disabling/removing the initiating control may itself move focus to the body.
      if (
        event.type === "focusin" &&
        event.target === document.body &&
        (pending.origin.matches(":disabled") || !pending.origin.isConnected)
      )
        return
      actionFocusRef.current = null
    }
    document.addEventListener("focusin", cancelActionFocus)
    document.addEventListener("pointerdown", cancelActionFocus)
    return () => {
      document.removeEventListener("focusin", cancelActionFocus)
      document.removeEventListener("pointerdown", cancelActionFocus)
    }
  }, [])

  // Virtual scrolling can unmount the input without changing the rename id or sessions.
  // Resolve the pending keyboard action after every list commit, before paint.
  useLayoutEffect(() => {
    const pending = actionFocusRef.current
    if (!pending) return
    if (pending.workspace !== selectedWorkspacePath) {
      actionFocusRef.current = null
      return
    }
    if (
      pending.kind === "remove"
        ? allSessions.some((session) => session.id === pending.id)
        : pending.origin.isConnected &&
          (pending.kind === "pin" || pending.kind === "renamed" || renamingSessionId === pending.id)
    )
      return
    actionFocusRef.current = null
    if (document.activeElement === document.body || document.activeElement === pending.origin) {
      const target = pending.target?.isConnected
        ? pending.target
        : pending.kind === "pin" && searchInputRef.current?.isConnected
          ? searchInputRef.current
          : listRef.current
      if (pending.kind === "rename" && target && target !== listRef.current) {
        // A saved title can leave the current search after the backend responds.
        // Keep guarding this focused row until it disappears or the user moves on.
        actionFocusRef.current = { ...pending, kind: "renamed", origin: target, target: null }
      }
      target?.focus({ preventScroll: true })
    }
  })

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
  const { virtualItems, totalHeight, scrollToIndex } = useVirtualList(flattenedSessions, listRef, {
    estimatedRowHeight: 57,
    overscan: 8,
    getItemKey: sessionItemKey,
  })
  const lastVirtualItem = virtualItems.at(-1)

  // Selection clears the filter in App. Reveal that exact result once, rather
  // than following selection during polling, ordinary scrolling or tab changes.
  const selectSession = (session: SessionSummary) => {
    const origin = sessionRowsRef.current
      .get(session.id)
      ?.querySelector<HTMLElement>(".session-select")
    searchSelectionRef.current =
      searchActive && origin
        ? {
            id: session.id,
            workspace: selectedWorkspacePath,
            origin,
            restoreFocus: document.activeElement === origin,
          }
        : null
    if (searchActive) {
      const ancestors = sessionGroupExpansionIds(sessionTree, session.id)
      setExpandedSessionIds((current) => new Set([...current, ...ancestors]))
    }
    onSelectSession(session)
  }

  useLayoutEffect(() => {
    const pending = searchSelectionRef.current
    const list = listRef.current
    if (!pending || !list) return
    if (
      pending.workspace !== selectedWorkspacePath ||
      selectedSessionId !== pending.id ||
      !allSessions.some((session) => session.id === pending.id)
    ) {
      searchSelectionRef.current = null
      return
    }
    if (searchActive) return
    const index = flattenedSessions.findIndex((item) => item.session.id === pending.id)
    if (index < 0) return
    const item = virtualItems.find((item) => item.index === index)
    const viewportHeight = list.clientHeight || 480
    const paddingTop = Number.parseFloat(getComputedStyle(list).paddingTop) || 0
    if (
      !item ||
      paddingTop + item.offset < list.scrollTop ||
      paddingTop + item.offset + Math.min(item.height, viewportHeight) >
        list.scrollTop + viewportHeight
    ) {
      // scrollToIndex publishes the new window synchronously; focus its real
      // control on the following commit, never a row that is about to unmount.
      scrollToIndex(index)
      // The shared virtualizer uses content offsets, not this list's padding.
      // Include its leading inset even at the final row's content-only clamp.
      list.scrollTop += paddingTop
      return
    }
    const target = sessionRowsRef.current
      .get(pending.id)
      ?.querySelector<HTMLElement>(".session-select")
    searchSelectionRef.current = null
    if (
      pending.restoreFocus &&
      (document.activeElement === document.body || document.activeElement === pending.origin)
    ) {
      target?.focus({ preventScroll: true })
    }
  })

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
            ref={searchInputRef}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t(lang, "searchSessions")}
            value={search}
          />
          {search && (
            <button
              onClick={() => {
                onClearSearch()
                searchInputRef.current?.focus()
              }}
              title={t(lang, "clearSearch")}
              type="button"
            >
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
              const keyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
                if (
                  (e.key === "Enter" || e.key === "Escape") &&
                  document.activeElement === e.currentTarget
                ) {
                  actionFocusRef.current = {
                    id: session.id,
                    workspace: selectedWorkspacePath,
                    kind: "rename",
                    origin: e.currentTarget,
                    target: e.currentTarget.closest<HTMLElement>(".session-select"),
                  }
                }
                onRenameKeyDown(e, session)
              }

              return (
                <div
                  key={session.id}
                  ref={(element) => {
                    if (element) sessionRowsRef.current.set(session.id, element)
                    else sessionRowsRef.current.delete(session.id)
                  }}
                  style={{ height: vi.height, display: "flow-root" }}
                >
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
                      actionFocusRef.current =
                        e.currentTarget instanceof HTMLButtonElement &&
                        document.activeElement === e.currentTarget
                          ? {
                              id: session.id,
                              workspace: selectedWorkspacePath,
                              kind: "remove",
                              origin: e.currentTarget,
                              target: null,
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
                        selectSession(session)
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
                    onCopyToWorkspace={
                      onCopySession
                        ? (event) => {
                            event.stopPropagation()
                            onCopySession(session)
                          }
                        : undefined
                    }
                    onLaunch={() => onLaunchSession(session)}
                    onRenameChange={onRenameValueChange}
                    onRenameKeyDown={keyDown}
                    onSelect={() => selectSession(session)}
                    onStartRename={(e) => {
                      e.stopPropagation()
                      onStartRename(session)
                    }}
                    onSubmitRename={submit}
                    onToggleTitlePin={(event) => {
                      event.stopPropagation()
                      actionFocusRef.current =
                        document.activeElement === event.currentTarget
                          ? {
                              id: session.id,
                              workspace: selectedWorkspacePath,
                              kind: "pin",
                              origin: event.currentTarget,
                              target: null,
                            }
                          : null
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

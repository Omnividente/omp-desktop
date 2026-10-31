import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { CompletedAnswers } from "./CompletedAnswers"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { RuntimeHealthStatus } from "./runtimeIncidents"
import { SessionControls } from "./SessionControls"
import { TerminalView } from "./TerminalView"
import type {
  OmpConfigSnapshot,
  PtyExitEvent,
  RuntimeInfo,
  SessionSummary,
  TerminalTab,
  WorkspaceSummary,
} from "./types"
import { WorkspaceHome } from "./WorkspaceHome"
import { buildSessionTree, latestSessionInTree } from "./uiUtils"

interface TerminalWorkspaceProps {
  activeTabId: string | null
  focusRequest: { terminalId: string; sequence: number } | null
  language: Lang
  terminalFontFamily: string
  terminalFontSize: number
  launching: string | null
  installingDesktopUpdate: boolean
  ompConfig: OmpConfigSnapshot | null
  runtime: RuntimeInfo
  runtimeStatusByTerminal: Record<string, RuntimeHealthStatus>
  selectedSession: SessionSummary | null
  selectedWorkspace: WorkspaceSummary | null
  tabs: TerminalTab[]
  workspaceSessions: SessionSummary[]
  onReorderTabs?: (draggedId: string, targetId: string) => void
  onDiscardSwitchRecovery: (terminalId: string) => void
  onCloseTab: (terminalId: string) => void
  onError: (message: string) => void
  onExit: (event: PtyExitEvent) => void
  onFocusTab: (terminalId: string) => void
  onLaunch: (session?: SessionSummary) => void
  onOpenFolder: () => void
  onReadTranscript: (path: string) => void
  onReady: (terminalId: string) => void
  onReveal: (path: string) => void
  onSendSwitchRecovery: (terminalId: string) => void
  onSwitch: (terminalId: string, model: string, thinking: string | null) => void
  onTogglePrimaryProviderPin: (terminalId: string, pinned: boolean) => void
  onToggleTitlePin: (tab: TerminalTab) => void
}

export function TerminalWorkspace({
  activeTabId,
  focusRequest,
  language,
  terminalFontFamily,
  terminalFontSize,
  launching,
  installingDesktopUpdate,
  ompConfig,
  runtime,
  runtimeStatusByTerminal,
  selectedSession,
  selectedWorkspace,
  tabs,
  workspaceSessions,
  onDiscardSwitchRecovery,
  onCloseTab,
  onError,
  onExit,
  onFocusTab,
  onLaunch,
  onOpenFolder,
  onReadTranscript,
  onReady,
  onReorderTabs,
  onReveal,
  onSendSwitchRecovery,
  onSwitch,
  onTogglePrimaryProviderPin,
  onToggleTitlePin,
}: TerminalWorkspaceProps) {
  const stageRef = useRef<HTMLElement>(null)
  const homePrimaryActionRef = useRef<HTMLButtonElement>(null)
  const focusOriginRef = useRef<HTMLElement | null>(null)
  const previousTabCountRef = useRef(tabs.length)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const activeHeaderRef = useRef<HTMLDivElement>(null)
  const previousActiveTabRef = useRef<string | null>(null)
  const lastRevealSequenceRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const selectionChanged = previousActiveTabRef.current !== activeTabId
    previousActiveTabRef.current = activeTabId
    const sequence = focusRequest?.sequence
    const newerRequest =
      sequence !== undefined &&
      Number.isFinite(sequence) &&
      (lastRevealSequenceRef.current === null || sequence > lastRevealSequenceRef.current)
    if (newerRequest) lastRevealSequenceRef.current = sequence
    if (!selectionChanged && !(newerRequest && focusRequest?.terminalId === activeTabId)) return

    const strip = tabStripRef.current
    const header = activeHeaderRef.current
    if (!activeTabId || !strip || !header) return
    const stripRect = strip.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const { clientLeft, clientWidth, scrollLeft, scrollWidth } = strip
    if (
      ![
        stripRect.left,
        stripRect.right,
        stripRect.width,
        headerRect.left,
        headerRect.right,
        headerRect.width,
        clientLeft,
        clientWidth,
        scrollLeft,
        scrollWidth,
      ].every(Number.isFinite) ||
      stripRect.width <= 0 ||
      stripRect.right <= stripRect.left ||
      headerRect.width <= 0 ||
      headerRect.right <= headerRect.left ||
      clientLeft < 0 ||
      clientWidth <= 0 ||
      scrollWidth < clientWidth
    )
      return

    const viewportLeft = stripRect.left + clientLeft
    const viewportRight = viewportLeft + clientWidth
    let nextScrollLeft = scrollLeft
    if (headerRect.width > clientWidth || headerRect.left < viewportLeft) {
      nextScrollLeft += headerRect.left - viewportLeft
    } else if (headerRect.right > viewportRight) {
      nextScrollLeft += headerRect.right - viewportRight
    }
    nextScrollLeft = Math.max(0, Math.min(scrollWidth - clientWidth, nextScrollLeft))
    if (Number.isFinite(nextScrollLeft) && nextScrollLeft !== scrollLeft) {
      strip.scrollLeft = nextScrollLeft
    }
  }, [activeTabId, focusRequest?.terminalId, focusRequest?.sequence])

  useEffect(() => {
    const cancelFocusRestoration = (event: Event) => {
      if (
        !focusOriginRef.current ||
        !(event.target instanceof Node) ||
        stageRef.current?.contains(event.target)
      )
        return
      // Native dialogs and removed controls can leave focus on the body.
      // An actual outside focus target or pointer action cancels restoration.
      if (event.type === "focusin" && event.target === document.body) return
      focusOriginRef.current = null
    }
    document.addEventListener("focusin", cancelFocusRestoration)
    document.addEventListener("pointerdown", cancelFocusRestoration)
    return () => {
      document.removeEventListener("focusin", cancelFocusRestoration)
      document.removeEventListener("pointerdown", cancelFocusRestoration)
    }
  }, [])

  useLayoutEffect(() => {
    const hadTabs = previousTabCountRef.current > 0
    previousTabCountRef.current = tabs.length
    if (!hadTabs || tabs.length !== 0) return
    const origin = focusOriginRef.current
    focusOriginRef.current = null
    if (
      !origin ||
      origin.isConnected ||
      (document.activeElement !== document.body && document.activeElement !== origin)
    )
      return
    const primary = homePrimaryActionRef.current
    const target =
      primary && !primary.disabled
        ? primary
        : stageRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    target?.focus({ preventScroll: true })
  }, [tabs.length])

  const homeSessions = useMemo(
    () =>
      buildSessionTree(workspaceSessions, runtime.platform).map((group) =>
        latestSessionInTree(group),
      ),
    [runtime.platform, workspaceSessions],
  )

  if (tabs.length === 0) {
    return (
      <main className="main-stage" ref={stageRef}>
        <WorkspaceHome
          lang={language}
          primaryActionRef={homePrimaryActionRef}
          launching={launching}
          onLaunch={onLaunch}
          onOpenFolder={onOpenFolder}
          onReveal={onReveal}
          runtime={runtime}
          selectedSession={selectedSession}
          sessions={homeSessions}
          workspace={selectedWorkspace}
        />
      </main>
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeRuntimeStatus = activeTab
    ? (runtimeStatusByTerminal[activeTab.id] ?? "normal")
    : "normal"
  return (
    <main
      className="main-stage"
      onFocusCapture={(event) => {
        focusOriginRef.current = event.target
      }}
      ref={stageRef}
    >
      <div className="terminal-workspace">
        <div className="terminal-tabs">
          <div className="terminal-tabs-scroll" ref={tabStripRef}>
            {tabs.map((tab) => {
              const runtimeStatus = runtimeStatusByTerminal[tab.id] ?? "normal"
              const visualStatus =
                runtimeStatus !== "normal"
                  ? runtimeStatus
                  : tab.activity === "thinking"
                    ? "thinking"
                    : "normal"
              const accessibleStatus =
                runtimeStatus === "error"
                  ? t(language, "sessionErrorTitle")
                  : runtimeStatus === "fallback"
                    ? t(language, "sessionFallbackTitle")
                    : tab.activity === "thinking"
                      ? t(language, "sessionThinkingTitle")
                      : tab.status === "running"
                        ? t(language, "sessionOpenTitle")
                        : t(language, "close")

              return (
                <div
                  className={`terminal-tab${tab.id === activeTabId ? " is-active" : ""} is-${tab.activity} is-runtime-${runtimeStatus}`}
                  draggable
                  key={tab.id}
                  ref={tab.id === activeTabId ? activeHeaderRef : null}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", tab.id)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const draggedId = event.dataTransfer.getData("text/plain")
                    if (draggedId && draggedId !== tab.id) {
                      onReorderTabs?.(draggedId, tab.id)
                    }
                  }}
                >
                  <button
                    aria-label={`${tab.label} — ${accessibleStatus}`}
                    onClick={() => onFocusTab(tab.id)}
                    title={accessibleStatus}
                    type="button"
                  >
                    <span className={`status-dot is-${tab.status} is-${visualStatus}`} />
                    <Icon name="terminal" size={14} />
                    <span className="terminal-tab-label">{tab.label}</span>
                    {runtimeStatus === "normal" && tab.activity === "thinking" && (
                      <span aria-live="polite" className="terminal-tab-thinking">
                        <span className="thinking-pulse" />
                        {t(language, "thinkingShort")}
                      </span>
                    )}
                    {runtimeStatus === "error" && (
                      <span aria-live="assertive" className="terminal-tab-error">
                        {t(language, "sessionErrorShort")}
                      </span>
                    )}
                    {runtimeStatus === "fallback" && (
                      <span aria-live="polite" className="terminal-tab-fallback">
                        {t(language, "fallbackActive")}
                      </span>
                    )}
                  </button>
                  {tab.sessionPath && (
                    <button
                      aria-pressed={tab.pinnedTitle !== null}
                      className={`tab-pin${tab.pinnedTitle ? " is-pinned" : ""}`}
                      disabled={tab.switching || tab.primaryProviderPinPending}
                      onClick={() => onToggleTitlePin(tab)}
                      title={t(language, tab.pinnedTitle ? "unpinSessionTitle" : "pinSessionTitle")}
                      type="button"
                    >
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                  <button
                    className="tab-close"
                    disabled={tab.switching || tab.primaryProviderPinPending}
                    onClick={() => onCloseTab(tab.id)}
                    title={
                      tab.status === "running" ? t(language, "stopAndClose") : t(language, "close")
                    }
                    type="button"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              )
            })}
            <button
              className="new-tab-button"
              disabled={!selectedWorkspace || launching !== null}
              onClick={() => onLaunch()}
              title={t(language, "btnNewSession")}
              type="button"
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          <div className="terminal-meta">
            {activeTab && (
              <SessionControls
                lang={language}
                installingDesktopUpdate={installingDesktopUpdate}
                ompConfig={ompConfig}
                onDiscardSwitchRecovery={onDiscardSwitchRecovery}
                onSendSwitchRecovery={onSendSwitchRecovery}
                onSwitch={onSwitch}
                onTogglePrimaryProviderPin={onTogglePrimaryProviderPin}
                runtimeStatus={activeRuntimeStatus}
                tab={activeTab}
              />
            )}
            {activeTab && (
              <button
                className="button secondary"
                disabled={activeTab.sessionPath === null || activeTab.switching}
                onClick={() => {
                  if (activeTab.sessionPath !== null) onReadTranscript(activeTab.sessionPath)
                }}
                title={t(language, "transcriptReadHint")}
                type="button"
              >
                <Icon name="history" size={14} />
                {t(language, "transcriptRead")}
              </button>
            )}
            {activeTab?.processId && <span>PID {activeTab.processId}</span>}
          </div>
        </div>
        <div className="terminal-stack">
          {tabs.map((tab) => (
            <div
              className={`terminal-pane${tab.id === activeTabId ? " is-active" : ""}`}
              key={tab.id}
            >
              {tab.kind === "agent" && tab.sessionPath && (
                <CompletedAnswers
                  key={tab.sessionPath}
                  active={tab.id === activeTabId}
                  busy={tab.status === "running" && (tab.activity === "thinking" || tab.switching)}
                  version={tab.completedResponseVersion ?? 0}
                  sessionPath={tab.sessionPath}
                  lang={language}
                  onError={onError}
                />
              )}
              <div className="terminal-pane-console">
                <TerminalView
                  active={tab.id === activeTabId}
                  focusRequestSequence={
                    focusRequest?.terminalId === tab.id ? focusRequest.sequence : 0
                  }
                  language={language}
                  platform={runtime.platform}
                  terminalFontFamily={terminalFontFamily}
                  terminalFontSize={terminalFontSize}
                  onError={onError}
                  onExit={onExit}
                  onReady={onReady}
                  tab={tab}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

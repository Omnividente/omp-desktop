import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CompletedAnswers } from "./CompletedAnswers"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { RuntimeHealthStatus } from "./runtimeIncidents"
import { SessionControls } from "./SessionControls"
import { TerminalView } from "./TerminalView"
import { TerminalTabPicker } from "./TerminalTabPicker"
import type {
  OmpConfigSnapshot,
  PtyExitEvent,
  RuntimeInfo,
  SessionSummary,
  TerminalTab,
  WorkspaceSummary,
} from "./types"
import { WorkspaceHome } from "./WorkspaceHome"
import { buildSessionTree, isSuccessfulTerminalTab, latestSessionInTree } from "./uiUtils"

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
  onCloseSuccessfulTabs?: () => void
  onError: (message: string) => void
  onExit: (event: PtyExitEvent) => void
  onFocusTab: (terminalId: string) => void
  onFocusTerminal: (terminalId: string) => void
  onShowWorkspace: () => void
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

function revealTabHeader(strip: HTMLDivElement, header: HTMLElement) {
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
  onCloseSuccessfulTabs,
  onError,
  onExit,
  onFocusTab,
  onFocusTerminal,
  onShowWorkspace,
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
  const [reorderAnnouncement, setReorderAnnouncement] = useState("")
  const keyboardReorderFocusRef = useRef<HTMLButtonElement | null>(null)

  useLayoutEffect(() => {
    const button = keyboardReorderFocusRef.current
    keyboardReorderFocusRef.current = null
    if (
      !button?.isConnected ||
      (document.activeElement !== document.body && document.activeElement !== button)
    )
      return
    if (document.activeElement !== button) button.focus({ preventScroll: true })
    const strip = tabStripRef.current
    const header = button.parentElement
    if (strip && header) revealTabHeader(strip, header)
  }, [tabs])

  const [tabPickerOpen, setTabPickerOpen] = useState(false)
  const successfulTabCount = tabs.filter(isSuccessfulTerminalTab).length
  const cleanupButtonRef = useRef<HTMLButtonElement>(null)
  const cleanupFocusRef = useRef(false)
  const stageRef = useRef<HTMLElement>(null)
  const homePrimaryActionRef = useRef<HTMLButtonElement>(null)
  const focusOriginRef = useRef<HTMLElement | null>(null)
  const previousTabCountRef = useRef(tabs.length)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const activeHeaderRef = useRef<HTMLDivElement>(null)
  const previousActiveTabRef = useRef<string | null>(null)
  const lastRevealSequenceRef = useRef<number | null>(null)

  useEffect(() => {
    if (tabs.length === 0) setTabPickerOpen(false)
  }, [tabs.length])

  useLayoutEffect(() => {
    const requested = cleanupFocusRef.current
    cleanupFocusRef.current = false
    if (!requested || successfulTabCount !== 0 || tabs.length === 0) return
    if (
      document.activeElement !== cleanupButtonRef.current &&
      document.activeElement !== document.body
    )
      return
    const target =
      activeHeaderRef.current?.querySelector<HTMLButtonElement>("button") ??
      tabStripRef.current?.querySelector<HTMLButtonElement>("button")
    target?.focus({ preventScroll: true })
  }, [successfulTabCount, tabs])

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
    revealTabHeader(strip, header)
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
          onError={onError}
          lang={language}
          primaryActionRef={homePrimaryActionRef}
          launching={launching}
          onLaunch={onLaunch}
          onOpenFolder={onOpenFolder}
          onReadTranscript={onReadTranscript}
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
          <span aria-live="polite" aria-atomic="true" className="sr-only">
            {reorderAnnouncement}
          </span>
          <button
            aria-label={t(language, "workspaceOverview")}
            aria-pressed={activeTabId === null}
            className="workspace-overview-button"
            disabled={launching !== null || installingDesktopUpdate}
            onClick={onShowWorkspace}
            title={t(language, "workspaceOverview")}
            type="button"
          >
            <Icon name="folder" size={15} />
          </button>
          <div className="terminal-tabs-scroll" ref={tabStripRef}>
            {tabs.map((tab, index) => {
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
                    aria-keyshortcuts={
                      onReorderTabs ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" : undefined
                    }
                    onClick={() => onFocusTab(tab.id)}
                    onKeyDown={(event) => {
                      if (
                        !onReorderTabs ||
                        event.defaultPrevented ||
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229 ||
                        !event.altKey ||
                        !event.shiftKey ||
                        event.ctrlKey ||
                        event.metaKey ||
                        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                      )
                        return
                      event.preventDefault()
                      event.stopPropagation()
                      const nextIndex = index + (event.key === "ArrowLeft" ? -1 : 1)
                      const target = tabs[nextIndex]
                      if (!target) return
                      keyboardReorderFocusRef.current = event.currentTarget
                      onReorderTabs(tab.id, target.id)
                      setReorderAnnouncement(
                        t(language, "tabReordered")
                          .replace("{position}", String(nextIndex + 1))
                          .replace("{count}", String(tabs.length))
                          .replace("{title}", () => tab.label),
                      )
                    }}
                    title={
                      onReorderTabs
                        ? accessibleStatus + ". " + t(language, "tabReorderHint")
                        : accessibleStatus
                    }
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
          <button
            aria-expanded={tabPickerOpen}
            aria-haspopup="dialog"
            aria-label={t(language, "terminalTabPickerTitle")}
            className="terminal-tab-picker-trigger"
            onClick={() => setTabPickerOpen(true)}
            title={t(language, "terminalTabPickerTitle")}
            type="button"
          >
            <Icon name="search" size={15} />
          </button>
          <div className="terminal-meta">
            {onCloseSuccessfulTabs && (
              <button
                aria-label={t(language, "closeSuccessfulTabs").replace(
                  "{count}",
                  String(successfulTabCount),
                )}
                className="button secondary close-successful-tabs"
                disabled={successfulTabCount === 0}
                onClick={(event) => {
                  cleanupFocusRef.current = document.activeElement === event.currentTarget
                  onCloseSuccessfulTabs()
                }}
                ref={cleanupButtonRef}
                title={
                  t(language, "closeSuccessfulTabs").replace(
                    "{count}",
                    String(successfulTabCount),
                  ) +
                  ". " +
                  t(language, "closeSuccessfulTabsHint")
                }
                type="button"
              >
                <Icon name="close" size={14} />
                <span aria-hidden="true">{successfulTabCount}</span>
              </button>
            )}
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
          {activeTabId === null && (
            <WorkspaceHome
              lang={language}
              primaryActionRef={homePrimaryActionRef}
              launching={launching}
              onLaunch={onLaunch}
              onOpenFolder={onOpenFolder}
              onReadTranscript={onReadTranscript}
              onError={onError}
              onReveal={onReveal}
              runtime={runtime}
              selectedSession={selectedSession}
              sessions={homeSessions}
              workspace={selectedWorkspace}
            />
          )}
        </div>
      </div>
      {tabPickerOpen && (
        <TerminalTabPicker
          activeTabId={activeTabId}
          language={language}
          onClose={() => setTabPickerOpen(false)}
          onSelect={(terminalId) => {
            setTabPickerOpen(false)
            onFocusTerminal(terminalId)
          }}
          tabs={tabs}
        />
      )}
    </main>
  )
}

import { useMemo } from "react"
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
  const homeSessions = useMemo(
    () =>
      buildSessionTree(workspaceSessions, runtime.platform).map((group) =>
        latestSessionInTree(group),
      ),
    [runtime.platform, workspaceSessions],
  )

  if (tabs.length === 0) {
    return (
      <main className="main-stage">
        <WorkspaceHome
          lang={language}
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
    <main className="main-stage">
      <div className="terminal-workspace">
        <div className="terminal-tabs">
          <div className="terminal-tabs-scroll">
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
                key={activeTab.id}
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

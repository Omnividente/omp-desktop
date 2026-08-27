import { useMemo } from "react"
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
  ompConfig: OmpConfigSnapshot | null
  runtime: RuntimeInfo
  runtimeStatusByTerminal: Record<string, RuntimeHealthStatus>
  selectedSession: SessionSummary | null
  selectedWorkspace: WorkspaceSummary | null
  tabs: TerminalTab[]
  workspaceSessions: SessionSummary[]
  onReorderTabs?: (draggedId: string, targetId: string) => void
  onCloseTab: (terminalId: string) => void
  onError: (message: string) => void
  onExit: (event: PtyExitEvent) => void
  onFocusTab: (terminalId: string) => void
  onLaunch: (session?: SessionSummary) => void
  onOpenFolder: () => void
  onReady: (terminalId: string) => void
  onReveal: (path: string) => void
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
  ompConfig,
  runtime,
  runtimeStatusByTerminal,
  selectedSession,
  selectedWorkspace,
  tabs,
  workspaceSessions,
  onCloseTab,
  onError,
  onExit,
  onFocusTab,
  onLaunch,
  onOpenFolder,
  onReady,
  onReorderTabs,
  onReveal,
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
                      disabled={tab.switching}
                      onClick={() => onToggleTitlePin(tab)}
                      title={t(language, tab.pinnedTitle ? "unpinSessionTitle" : "pinSessionTitle")}
                      type="button"
                    >
                      <Icon name="pin" size={12} />
                    </button>
                  )}
                  <button
                    className="tab-close"
                    disabled={tab.switching}
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
                ompConfig={ompConfig}
                onSwitch={onSwitch}
                onTogglePrimaryProviderPin={onTogglePrimaryProviderPin}
                runtimeStatus={activeRuntimeStatus}
                tab={activeTab}
              />
            )}
            {activeTab?.processId && <span>PID {activeTab.processId}</span>}
          </div>
        </div>
        <div className="terminal-stack">
          {tabs.map((tab) => (
            <TerminalView
              active={tab.id === activeTabId}
              focusRequestSequence={focusRequest?.terminalId === tab.id ? focusRequest.sequence : 0}
              language={language}
              terminalFontFamily={terminalFontFamily}
              terminalFontSize={terminalFontSize}
              key={tab.id}
              onError={onError}
              onExit={onExit}
              onReady={onReady}
              tab={tab}
            />
          ))}
        </div>
      </div>
    </main>
  )
}

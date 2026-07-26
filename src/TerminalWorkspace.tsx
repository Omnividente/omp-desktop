import { Icon } from "./Icon";
import { t, type Lang } from "./i18n";
import { SessionControls } from "./SessionControls";
import { TerminalView } from "./TerminalView";
import type {
  OmpConfigSnapshot,
  PtyExitEvent,
  RuntimeInfo,
  SessionSummary,
  TerminalTab,
  WorkspaceSummary,
} from "./types";
import { WorkspaceHome } from "./WorkspaceHome";

interface TerminalWorkspaceProps {
  activeTabId: string | null;
  language: Lang;
  terminalFontFamily: string;
  terminalFontSize: number;
  launching: string | null;
  ompConfig: OmpConfigSnapshot | null;
  runtime: RuntimeInfo;
  selectedSession: SessionSummary | null;
  selectedWorkspace: WorkspaceSummary | null;
  tabs: TerminalTab[];
  workspaceSessions: SessionSummary[];
  onReorderTabs?: (draggedId: string, targetId: string) => void;
  onCloseTab: (terminalId: string) => void;
  onError: (message: string) => void;
  onExit: (event: PtyExitEvent) => void;
  onFocusTab: (terminalId: string) => void;
  onLaunch: (session?: SessionSummary) => void;
  onOpenFolder: () => void;
  onReady: (terminalId: string) => void;
  onReveal: (path: string) => void;
  onSwitch: (terminalId: string, model: string, thinking: string | null) => void;
}

export function TerminalWorkspace({
  activeTabId,
  language,
  terminalFontFamily,
  terminalFontSize,
  launching,
  ompConfig,
  runtime,
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
}: TerminalWorkspaceProps) {
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
          sessions={workspaceSessions}
          workspace={selectedWorkspace}
        />
      </main>
    );
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  return (
    <main className="main-stage">
      <div className="terminal-workspace">
        <div className="terminal-tabs">
          <div className="terminal-tabs-scroll">
            {tabs.map((tab) => (
              <div
                className={`terminal-tab${tab.id === activeTabId ? " is-active" : ""} is-${tab.activity}`}
                draggable
                key={tab.id}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", tab.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData("text/plain");
                  if (draggedId && draggedId !== tab.id) {
                    onReorderTabs?.(draggedId, tab.id);
                  }
                }}
              >
                <button
                  aria-label={`${tab.label} — ${tab.activity === "thinking" ? t(language, "sessionThinkingTitle") : tab.activity === "error" ? t(language, "sessionErrorTitle") : tab.status === "running" ? t(language, "sessionOpenTitle") : t(language, "close")}`}
                  onClick={() => onFocusTab(tab.id)}
                  title={
                    tab.activity === "thinking"
                      ? t(language, "sessionThinkingTitle")
                      : tab.activity === "error"
                        ? t(language, "sessionErrorTitle")
                        : undefined
                  }
                  type="button"
                >
                  <span className={`status-dot is-${tab.status} is-${tab.activity}`} />
                  <Icon name="terminal" size={14} />
                  <span className="terminal-tab-label">{tab.label}</span>
                  {tab.activity === "thinking" && (
                    <span aria-live="polite" className="terminal-tab-thinking">
                      <span className="thinking-pulse" />
                      {t(language, "thinkingShort")}
                    </span>
                  )}
                  {tab.activity === "error" && (
                    <span aria-live="assertive" className="terminal-tab-error">
                      {t(language, "sessionErrorShort")}
                    </span>
                  )}
                </button>
                <button
                  className="tab-close"
                  disabled={tab.switching}
                  onClick={() => onCloseTab(tab.id)}
                  title={tab.status === "running" ? t(language, "stopAndClose") : t(language, "close")}
                  type="button"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
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
  );
}

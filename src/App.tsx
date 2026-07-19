import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  addWorkspace,
  bootstrap as loadBootstrap,
  closeTerminal,
  errorMessage,
  startTerminal,
} from "./api";
import { Icon } from "./Icon";
import { SettingsPanel } from "./SettingsPanel";
import { TerminalView } from "./TerminalView";
import type {
  BootstrapPayload,
  PtyExitEvent,
  RuntimeInfo,
  SessionSummary,
  TerminalTab,
  WorkspaceSummary,
} from "./types";
import "./App.css";

const relativeTime = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
const calendarDate = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "short",
});


function normalizedPath(path: string, platform: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function formatRelative(timestamp: number): string {
  if (!timestamp) {
    return "нет запусков";
  }
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) {
    return relativeTime.format(seconds, "second");
  }
  if (absolute < 3_600) {
    return relativeTime.format(Math.round(seconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return relativeTime.format(Math.round(seconds / 3_600), "hour");
  }
  if (absolute < 604_800) {
    return relativeTime.format(Math.round(seconds / 86_400), "day");
  }
  return calendarDate.format(timestamp);
}

interface WorkspaceHomeProps {
  workspace: WorkspaceSummary | null;
  sessions: SessionSummary[];
  selectedSession: SessionSummary | null;
  runtime: RuntimeInfo;
  launching: string | null;
  onLaunch: (session?: SessionSummary) => void;
  onReveal: (path: string) => void;
  onOpenFolder: () => void;
}

function WorkspaceHome({
  workspace,
  sessions,
  selectedSession,
  runtime,
  launching,
  onLaunch,
  onReveal,
  onOpenFolder,
}: WorkspaceHomeProps) {
  if (!workspace) {
    return (
      <section className="empty-workspace">
        <div className="empty-orbit" aria-hidden="true">
          <span />
          <Icon name="folderOpen" size={34} />
        </div>
        <span className="eyebrow">Начало работы</span>
        <h1>Откройте папку проекта</h1>
        <p>
          OMP Desktop запустит агента в выбранной папке и соберёт связанные с ней сессии.
        </p>
        <button className="button primary large" onClick={onOpenFolder} type="button">
          <Icon name="folderOpen" />
          Открыть папку
        </button>
        <span className="shortcut-hint">Ctrl + Shift + O</span>
      </section>
    );
  }

  const latest = sessions[0] ?? null;
  const focusSession = selectedSession ?? latest;
  return (
    <div className="workspace-home">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">
            <Icon name="spark" size={14} />
            Рабочая папка готова
          </span>
          <h1>{workspace.name}</h1>
          <button
            className="hero-path"
            onClick={() => onReveal(workspace.path)}
            title="Показать в проводнике"
            type="button"
          >
            <span>{workspace.path}</span>
            <Icon name="external" size={14} />
          </button>
          <p>
            Новый терминал наследует эту папку. История OMP остаётся в обычном формате JSONL.
          </p>
          <div className="hero-actions">
            <button
              className="button primary large"
              disabled={launching !== null || !runtime.ompAvailable}
              onClick={() => onLaunch()}
              type="button"
            >
              <Icon name="plus" />
              {launching === "new" ? "Запускаем…" : "Новая сессия"}
            </button>
            {focusSession && (
              <button
                className="button secondary large"
                disabled={launching !== null || !runtime.ompAvailable}
                onClick={() => onLaunch(focusSession)}
                type="button"
              >
                <Icon name="play" />
                Продолжить последнюю
              </button>
            )}
          </div>
        </div>
        <div className="hero-mark" aria-hidden="true">
          <Icon name="logo" size={112} />
          <span>OMP</span>
        </div>
      </section>

      <section className="stats-grid" aria-label="Сводка проекта">
        <article>
          <span>Сессии</span>
          <strong>{workspace.sessionCount}</strong>
          <small>в этой папке</small>
        </article>
        <article>
          <span>Последний запуск</span>
          <strong className="stat-text">{formatRelative(workspace.lastActive)}</strong>
          <small>по времени файла</small>
        </article>
        <article>
          <span>Runtime</span>
          <strong className="stat-text">
            {runtime.ompVersion?.replace(/^omp(?:\s+|\/)/i, "") ?? "не найден"}
          </strong>
          <small>{runtime.platform} · {runtime.arch}</small>
        </article>
      </section>

      <section className="recent-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Недавнее</span>
            <h2>Продолжить работу</h2>
          </div>
          <span className="muted-count">{sessions.length} всего</span>
        </div>
        {sessions.length === 0 ? (
          <div className="inline-empty">
            <Icon name="history" />
            <div>
              <strong>Сессий пока нет</strong>
              <span>Запустите OMP — новая сессия появится здесь автоматически.</span>
            </div>
          </div>
        ) : (
          <div className="recent-list">
            {sessions.slice(0, 4).map((session) => (
              <button key={session.id} onClick={() => onLaunch(session)} type="button">
                <span className="recent-icon"><Icon name="history" /></span>
                <span className="recent-copy">
                  <strong>{session.title}</strong>
                  <small>
                    {session.model?.split("/").at(-1) ?? "модель не указана"} · {formatRelative(session.updatedAt)}
                  </small>
                </span>
                <Icon name="arrow" size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function App() {
  const [payload, setPayload] = useState<BootstrapPayload | null>(null);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);

  const showError = useCallback((message: string) => {
    setToast(message);
  }, []);

  const applyPayload = useCallback(
    (next: BootstrapPayload, preferredWorkspace?: string) => {
      setPayload(next);
      setStartupError(null);
      setSelectedWorkspacePath((current) => {
        const preferred = preferredWorkspace ?? current;
        if (preferred) {
          const preferredKey = normalizedPath(preferred, next.runtime.platform);
          const match = next.workspaces.find(
            (workspace) => normalizedPath(workspace.path, next.runtime.platform) === preferredKey,
          );
          if (match) {
            return match.path;
          }
        }
        return next.workspaces[0]?.path ?? null;
      });
      setSelectedSessionId((current) =>
        current && next.sessions.some((session) => session.id === current) ? current : null,
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      applyPayload(await loadBootstrap());
    } catch (error) {
      const message = errorMessage(error);
      setStartupError(message);
      showError(message);
    } finally {
      setRefreshing(false);
    }
  }, [applyPayload, showError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => setToast(null), 5_500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selectedWorkspace = useMemo(() => {
    if (!payload || !selectedWorkspacePath) {
      return null;
    }
    const selectedKey = normalizedPath(selectedWorkspacePath, payload.runtime.platform);
    return (
      payload.workspaces.find(
        (workspace) => normalizedPath(workspace.path, payload.runtime.platform) === selectedKey,
      ) ?? null
    );
  }, [payload, selectedWorkspacePath]);

  const workspaceSessions = useMemo(() => {
    if (!payload || !selectedWorkspace) {
      return [];
    }
    const workspaceKey = normalizedPath(selectedWorkspace.path, payload.runtime.platform);
    return payload.sessions.filter(
      (session) => normalizedPath(session.cwd, payload.runtime.platform) === workspaceKey,
    );
  }, [payload, selectedWorkspace]);

  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru");
    if (!query) {
      return workspaceSessions;
    }
    return workspaceSessions.filter((session) =>
      [session.title, session.model ?? "", session.id]
        .join(" ")
        .toLocaleLowerCase("ru")
        .includes(query),
    );
  }, [search, workspaceSessions]);

  const selectedSession =
    workspaceSessions.find((session) => session.id === selectedSessionId) ?? null;

  const openFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Открыть проект в OMP Desktop",
      });
      if (typeof selected !== "string") {
        return;
      }
      const next = await addWorkspace(selected);
      applyPayload(next, selected);
      setSelectedSessionId(null);
      setSearch("");
    } catch (error) {
      showError(errorMessage(error));
    }
  }, [applyPayload, showError]);

  const reveal = useCallback(
    (path: string) => {
      void revealItemInDir(path).catch((error) => showError(errorMessage(error)));
    },
    [showError],
  );

  const launchSession = useCallback(
    async (session?: SessionSummary) => {
      if (!payload || launching !== null) {
        return;
      }
      const cwd = session?.cwd ?? selectedWorkspace?.path;
      if (!cwd) {
        showError("Сначала выберите папку проекта");
        return;
      }
      if (!payload.runtime.ompAvailable) {
        setSettingsOpen(true);
        showError("OMP не найден — укажите исполняемый файл в настройках");
        return;
      }
      if (session) {
        const existing = tabs.find(
          (tab) => tab.sessionId === session.id && tab.status === "running",
        );
        if (existing) {
          setActiveTabId(existing.id);
          return;
        }
      }

      const launchKey = session?.id ?? "new";
      setLaunching(launchKey);
      try {
        const started = await startTerminal(cwd, session?.filePath ?? null);
        const tab: TerminalTab = {
          id: started.terminalId,
          label: session?.title ?? `Новая · ${selectedWorkspace?.name ?? "OMP"}`,
          cwd: started.cwd,
          processId: started.processId,
          sessionId: session?.id ?? null,
          status: "running",
          exitCode: null,
          success: null,
        };
        setTabs((current) => [...current, tab]);
        setActiveTabId(tab.id);
      } catch (error) {
        showError(errorMessage(error));
      } finally {
        setLaunching(null);
      }
    },
    [launching, payload, selectedWorkspace, showError, tabs],
  );

  const closeTab = useCallback(
    (terminalId: string) => {
      void closeTerminal(terminalId).catch((error) => showError(errorMessage(error)));
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === terminalId);
        const remaining = current.filter((tab) => tab.id !== terminalId);
        setActiveTabId((active) => {
          if (active !== terminalId) {
            return active;
          }
          return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null;
        });
        return remaining;
      });
    },
    [showError],
  );

  const handleExit = useCallback((event: PtyExitEvent) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === event.terminalId
          ? {
              ...tab,
              status: "exited",
              exitCode: event.exitCode,
              success: event.success,
            }
          : tab,
      ),
    );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.shiftKey && event.code === "KeyO") {
        event.preventDefault();
        void openFolder();
      } else if (modifier && event.code === "KeyN") {
        event.preventDefault();
        void launchSession();
      } else if (modifier && event.code === "KeyW" && activeTabId) {
        event.preventDefault();
        closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, closeTab, launchSession, openFolder]);

  if (!payload) {
    return (
      <main className="splash-screen">
        <div className="splash-logo"><Icon name="logo" size={58} /></div>
        <h1>OMP Desktop</h1>
        {refreshing ? (
          <p><span className="loading-dot" /> Ищем проекты и сессии…</p>
        ) : (
          <>
            <p className="splash-error">{startupError ?? "Не удалось загрузить данные OMP"}</p>
            <button className="button primary" onClick={() => void refresh()} type="button">
              <Icon name="refresh" /> Повторить
            </button>
          </>
        )}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="logo" size={26} /></span>
          <strong>OMP</strong>
          <span>Desktop</span>
        </div>
        <div className="topbar-context">
          <Icon name="folder" size={15} />
          <span>{selectedWorkspace?.name ?? "Проект не выбран"}</span>
          {selectedWorkspace && <small>{selectedWorkspace.path}</small>}
        </div>
        <div className="topbar-actions">
          <button
            className={`runtime-pill ${payload.runtime.ompAvailable ? "is-ready" : "is-error"}`}
            onClick={() => setSettingsOpen(true)}
            type="button"
          >
            <span />
            {payload.runtime.ompVersion ?? "OMP не найден"}
          </button>
          <button
            className={`icon-button${refreshing ? " is-spinning" : ""}`}
            disabled={refreshing}
            onClick={() => void refresh()}
            title="Обновить список"
            type="button"
          >
            <Icon name="refresh" />
          </button>
          <button
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            title="Настройки"
            type="button"
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className="workbench">
        <aside className="project-rail">
          <div className="section-title">
            <span>Проекты</span>
            <button onClick={() => void openFolder()} title="Открыть папку" type="button">
              <Icon name="plus" size={16} />
            </button>
          </div>
          <nav className="project-list" aria-label="Проекты">
            {payload.workspaces.map((workspace) => {
              const active = selectedWorkspace
                ? normalizedPath(workspace.path, payload.runtime.platform) ===
                  normalizedPath(selectedWorkspace.path, payload.runtime.platform)
                : false;
              return (
                <button
                  className={`project-item${active ? " is-active" : ""}`}
                  key={normalizedPath(workspace.path, payload.runtime.platform)}
                  onClick={() => {
                    setSelectedWorkspacePath(workspace.path);
                    setSelectedSessionId(null);
                    setSearch("");
                  }}
                  title={workspace.path}
                  type="button"
                >
                  <span className="project-glyph">
                    <Icon name="folder" size={17} />
                  </span>
                  <span className="project-copy">
                    <strong>{workspace.name}</strong>
                    <small>{workspace.sessionCount} сесс.</small>
                  </span>
                  {workspace.pinned && <span className="pin-dot" title="Недавний проект" />}
                </button>
              );
            })}
          </nav>
          <button className="open-project-button" onClick={() => void openFolder()} type="button">
            <Icon name="folderOpen" size={16} />
            Открыть папку
          </button>
          <div className="rail-footer">
            <Icon name="command" size={15} />
            <span>Ctrl + N</span>
            <small>новая сессия</small>
          </div>
        </aside>

        <aside className="session-sidebar">
          <div className="session-header">
            <div className="session-project-row">
              <div>
                <span className="eyebrow">Сессии</span>
                <h2>{selectedWorkspace?.name ?? "Нет проекта"}</h2>
              </div>
              {selectedWorkspace && (
                <button
                  className="icon-button compact"
                  onClick={() => reveal(selectedWorkspace.path)}
                  title="Показать папку"
                  type="button"
                >
                  <Icon name="external" size={15} />
                </button>
              )}
            </div>
            <button
              className="button primary new-session-button"
              disabled={!selectedWorkspace || launching !== null || !payload.runtime.ompAvailable}
              onClick={() => void launchSession()}
              type="button"
            >
              <Icon name="plus" size={16} />
              {launching === "new" ? "Запускаем…" : "Новая сессия"}
            </button>
            <label className="search-box">
              <Icon name="search" size={15} />
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Поиск сессий"
                value={search}
              />
              {search && (
                <button onClick={() => setSearch("")} title="Очистить" type="button">
                  <Icon name="close" size={13} />
                </button>
              )}
            </label>
          </div>

          <div className="session-list">
            {visibleSessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const busy = launching === session.id;
              return (
                <article className={`session-item${selected ? " is-selected" : ""}`} key={session.id}>
                  <button
                    className="session-select"
                    onClick={() => setSelectedSessionId(session.id)}
                    onDoubleClick={() => void launchSession(session)}
                    title={session.title}
                    type="button"
                  >
                    <span className="session-icon"><Icon name="history" size={16} /></span>
                    <span className="session-copy">
                      <strong>{session.title}</strong>
                      <small>
                        {formatRelative(session.updatedAt)}
                        <i>·</i>
                        {session.model?.split("/").at(-1) ?? "без модели"}
                      </small>
                    </span>
                  </button>
                  <button
                    className="session-play"
                    disabled={launching !== null || !payload.runtime.ompAvailable}
                    onClick={() => void launchSession(session)}
                    title="Продолжить сессию"
                    type="button"
                  >
                    {busy ? <span className="mini-loader" /> : <Icon name="play" size={14} />}
                  </button>
                </article>
              );
            })}
            {selectedWorkspace && visibleSessions.length === 0 && (
              <div className="sidebar-empty">
                <Icon name={search ? "search" : "history"} />
                <strong>{search ? "Ничего не найдено" : "История пуста"}</strong>
                <span>
                  {search ? "Попробуйте другой запрос" : "Создайте первую сессию в этой папке"}
                </span>
              </div>
            )}
          </div>
          <div className="session-footer">
            <span>{workspaceSessions.length} сессий</span>
            <small>JSONL · OMP native</small>
          </div>
        </aside>

        <main className="main-stage">
          {tabs.length > 0 ? (
            <div className="terminal-workspace">
              <div className="terminal-tabs">
                <div className="terminal-tabs-scroll">
                  {tabs.map((tab) => (
                    <div
                      className={`terminal-tab${tab.id === activeTabId ? " is-active" : ""}`}
                      key={tab.id}
                    >
                      <button onClick={() => setActiveTabId(tab.id)} type="button">
                        <span className={`status-dot is-${tab.status}`} />
                        <Icon name="terminal" size={14} />
                        <span>{tab.label}</span>
                      </button>
                      <button
                        className="tab-close"
                        onClick={() => closeTab(tab.id)}
                        title={tab.status === "running" ? "Остановить и закрыть" : "Закрыть"}
                        type="button"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="new-tab-button"
                    disabled={!selectedWorkspace || launching !== null}
                    onClick={() => void launchSession()}
                    title="Новая сессия"
                    type="button"
                  >
                    <Icon name="plus" size={15} />
                  </button>
                </div>
                <div className="terminal-meta">
                  {tabs.find((tab) => tab.id === activeTabId)?.processId && (
                    <span>PID {tabs.find((tab) => tab.id === activeTabId)?.processId}</span>
                  )}
                </div>
              </div>
              <div className="terminal-stack">
                {tabs.map((tab) => (
                  <TerminalView
                    active={tab.id === activeTabId}
                    key={tab.id}
                    onError={showError}
                    onExit={handleExit}
                    tab={tab}
                  />
                ))}
              </div>
            </div>
          ) : (
            <WorkspaceHome
              launching={launching}
              onLaunch={(session) => void launchSession(session)}
              onOpenFolder={() => void openFolder()}
              onReveal={reveal}
              runtime={payload.runtime}
              selectedSession={selectedSession}
              sessions={workspaceSessions}
              workspace={selectedWorkspace}
            />
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onError={showError}
          onSaved={applyPayload}
          runtime={payload.runtime}
          settings={payload.settings}
        />
      )}

      {toast && (
        <div className="error-toast" role="alert">
          <Icon name="alert" size={17} />
          <span>{toast}</span>
          <button onClick={() => setToast(null)} title="Закрыть" type="button">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  addWorkspace,
  bootstrap as loadBootstrap,
  checkOmpUpdate,
  closeTerminal,
  errorMessage,
  importSession,
  listCodexSessions,
  renameSession,
  startTerminal,
} from "./api";
import { Icon } from "./Icon";
import { t, type Lang } from "./i18n";
import { SettingsPanel } from "./SettingsPanel";
import { TerminalView } from "./TerminalView";
import type {
  BootstrapPayload,
  CodexSessionSummary,
  OmpUpdateInfo,
  PtyExitEvent,
  RuntimeInfo,
  SessionSummary,
  TerminalTab,
  WorkspaceSummary,
} from "./types";
import "./App.css";

function localeTag(lang: Lang): string {
  return lang === "en" ? "en" : "ru";
}

function normalizedPath(path: string, platform: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function formatRelative(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков";
  }
  const relativeTime = new Intl.RelativeTimeFormat(localeTag(lang), { numeric: "auto" });
  const calendarDate = new Intl.DateTimeFormat(localeTag(lang), {
    day: "numeric",
    month: "short",
  });
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relativeTime.format(seconds, "second");
  if (absolute < 3_600) return relativeTime.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return relativeTime.format(Math.round(seconds / 3_600), "hour");
  if (absolute < 604_800) return relativeTime.format(Math.round(seconds / 86_400), "day");
  return calendarDate.format(timestamp);
}

interface WorkspaceHomeProps {
  workspace: WorkspaceSummary | null;
  sessions: SessionSummary[];
  selectedSession: SessionSummary | null;
  runtime: RuntimeInfo;
  launching: string | null;
  lang: Lang;
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
  lang,
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
        <span className="eyebrow">{t(lang, "startWork")}</span>
        <h1>{t(lang, "emptyTitle")}</h1>
        <p>{t(lang, "emptyDesc")}</p>
        <button className="button primary large" onClick={onOpenFolder} type="button">
          <Icon name="folderOpen" />
          {t(lang, "btnOpenFolder")}
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
            {t(lang, "workspaceReady")}
          </span>
          <h1>{workspace.name}</h1>
          <button
            className="hero-path"
            onClick={() => onReveal(workspace.path)}
            title={t(lang, "showInExplorer")}
            type="button"
          >
            <span>{workspace.path}</span>
            <Icon name="external" size={14} />
          </button>
          <p>{t(lang, "workspaceDesc")}</p>
          <div className="hero-actions">
            <button
              className="button primary large"
              disabled={launching !== null || !runtime.ompAvailable}
              onClick={() => onLaunch()}
              type="button"
            >
              <Icon name="plus" />
              {launching === "new" ? t(lang, "launching") : t(lang, "btnNewSession")}
            </button>
            {focusSession && (
              <button
                className="button secondary large"
                disabled={launching !== null || !runtime.ompAvailable}
                onClick={() => onLaunch(focusSession)}
                type="button"
              >
                <Icon name="play" />
                {t(lang, "btnResumeLast")}
              </button>
            )}
          </div>
        </div>
        <div className="hero-mark" aria-hidden="true">
          <Icon name="logo" size={112} />
          <span>OMP</span>
        </div>
      </section>

      <section className="stats-grid" aria-label={t(lang, "statSessions")}>
        <article>
          <span>{t(lang, "statSessions")}</span>
          <strong>{workspace.sessionCount}</strong>
          <small>{t(lang, "statInFolder")}</small>
        </article>
        <article>
          <span>{t(lang, "statLastRun")}</span>
          <strong className="stat-text">{formatRelative(workspace.lastActive, lang)}</strong>
          <small>{t(lang, "statByFileTime")}</small>
        </article>
        <article>
          <span>Runtime</span>
          <strong className="stat-text">
            {runtime.ompVersion?.replace(/^omp(?:\s+|\/)/i, "") ?? t(lang, "notFound")}
          </strong>
          <small>
            {runtime.platform} · {runtime.arch}
          </small>
        </article>
      </section>

      <section className="recent-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">{t(lang, "recent")}</span>
            <h2>{t(lang, "continueWork")}</h2>
          </div>
          <span className="muted-count">
            {sessions.length} {t(lang, "total")}
          </span>
        </div>
        {sessions.length === 0 ? (
          <div className="inline-empty">
            <Icon name="history" />
            <div>
              <strong>{t(lang, "noSessionsYet")}</strong>
              <span>{t(lang, "noSessionsDesc")}</span>
            </div>
          </div>
        ) : (
          <div className="recent-list">
            {sessions.slice(0, 4).map((session) => (
              <button key={session.id} onClick={() => onLaunch(session)} type="button">
                <span className="recent-icon">
                  <Icon name="history" />
                </span>
                <span className="recent-copy">
                  <strong>{session.title}</strong>
                  <small>
                    {session.model?.split("/").at(-1) ?? t(lang, "noModel")} ·{" "}
                    {formatRelative(session.updatedAt, lang)}
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
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [updateInfo, setUpdateInfo] = useState<OmpUpdateInfo | null>(null);
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexSessions, setCodexSessions] = useState<CodexSessionSummary[]>([]);
  const [codexSelected, setCodexSelected] = useState<Record<string, boolean>>({});
  const [codexLoading, setCodexLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const lang: Lang = payload?.settings.language === "en" ? "en" : "ru";

  const showError = useCallback((message: string) => {
    setToast(message);
  }, []);

  const applyPayload = useCallback((next: BootstrapPayload, preferredWorkspace?: string) => {
    setPayload(next);
    setStartupError(null);
    setSelectedWorkspacePath((current) => {
      const preferred = preferredWorkspace ?? current;
      if (preferred) {
        const preferredKey = normalizedPath(preferred, next.runtime.platform);
        const match = next.workspaces.find(
          (workspace) => normalizedPath(workspace.path, next.runtime.platform) === preferredKey,
        );
        if (match) return match.path;
      }
      return next.workspaces[0]?.path ?? null;
    });
    setSelectedSessionId((current) =>
      current && next.sessions.some((session) => session.id === current) ? current : null,
    );
  }, []);

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
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 5_500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!payload?.runtime.ompAvailable) {
      setUpdateInfo(null);
      return;
    }
    void checkOmpUpdate()
      .then(setUpdateInfo)
      .catch(() => setUpdateInfo(null));
  }, [payload?.runtime.ompAvailable, payload?.runtime.ompVersion]);

  const selectedWorkspace = useMemo(() => {
    if (!payload || !selectedWorkspacePath) return null;
    const selectedKey = normalizedPath(selectedWorkspacePath, payload.runtime.platform);
    return (
      payload.workspaces.find(
        (workspace) => normalizedPath(workspace.path, payload.runtime.platform) === selectedKey,
      ) ?? null
    );
  }, [payload, selectedWorkspacePath]);

  const workspaceSessions = useMemo(() => {
    if (!payload || !selectedWorkspace) return [];
    const workspaceKey = normalizedPath(selectedWorkspace.path, payload.runtime.platform);
    return payload.sessions.filter(
      (session) => normalizedPath(session.cwd, payload.runtime.platform) === workspaceKey,
    );
  }, [payload, selectedWorkspace]);

  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(localeTag(lang));
    if (!query) return workspaceSessions;
    return workspaceSessions.filter((session) =>
      [session.title, session.model ?? "", session.id, session.source]
        .join(" ")
        .toLocaleLowerCase(localeTag(lang))
        .includes(query),
    );
  }, [lang, search, workspaceSessions]);

  const selectedSession =
    workspaceSessions.find((session) => session.id === selectedSessionId) ?? null;

  const openFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t(lang, "pickProjectDir"),
      });
      if (typeof selected !== "string") return;
      const next = await addWorkspace(selected);
      applyPayload(next, selected);
      setSelectedSessionId(null);
      setSearch("");
    } catch (error) {
      showError(errorMessage(error));
    }
  }, [applyPayload, lang, showError]);

  const reveal = useCallback(
    (path: string) => {
      void revealItemInDir(path).catch((error) => showError(errorMessage(error)));
    },
    [showError],
  );

  const launchSession = useCallback(
    async (session?: SessionSummary) => {
      if (!payload || launching !== null) return;
      const cwd = session?.cwd ?? selectedWorkspace?.path;
      if (!cwd) {
        showError(t(lang, "requireProjectDir"));
        return;
      }
      if (!payload.runtime.ompAvailable) {
        setSettingsOpen(true);
        showError(t(lang, "requireOmp"));
        return;
      }
      if (session) {
        const existing = tabs.find((tab) => tab.sessionId === session.id && tab.status === "running");
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
          label:
            session?.title ??
            `${lang === "en" ? "New" : "Новая"} · ${selectedWorkspace?.name ?? "OMP"}`,
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
    [lang, launching, payload, selectedWorkspace, showError, tabs],
  );

  const launchUpdate = useCallback(async () => {
    if (!payload?.runtime.ompAvailable || !selectedWorkspace?.path || launching !== null) return;
    setLaunching("update");
    try {
      const started = await startTerminal(selectedWorkspace.path, null, 120, 36, ["update"]);
      const tab: TerminalTab = {
        id: started.terminalId,
        label: "OMP Update",
        cwd: started.cwd,
        processId: started.processId,
        sessionId: null,
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
  }, [launching, payload?.runtime.ompAvailable, selectedWorkspace?.path, showError]);

  const openCodexImport = useCallback(async () => {
    setCodexOpen(true);
    setCodexLoading(true);
    try {
      const sessions = await listCodexSessions();
      setCodexSessions(sessions);
      setCodexSelected({});
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setCodexLoading(false);
    }
  }, [showError]);

  const importCodexSelected = useCallback(async () => {
    if (!selectedWorkspace?.path) {
      showError(t(lang, "requireProjectDir"));
      return;
    }
    const selected = codexSessions.filter((session) => codexSelected[session.filePath]);
    if (selected.length === 0) return;
    setImporting(true);
    try {
      let nextPayload: BootstrapPayload | null = null;
      for (const session of selected) {
        nextPayload = await importSession(session.filePath, selectedWorkspace.path);
      }
      if (nextPayload) applyPayload(nextPayload, selectedWorkspace.path);
      setCodexOpen(false);
      setToast(`${t(lang, "imported")}: ${selected.length}`);
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }, [applyPayload, codexSelected, codexSessions, lang, selectedWorkspace?.path, showError]);

  const importOmpFile = useCallback(async () => {
    if (!selectedWorkspace?.path) {
      showError(t(lang, "requireProjectDir"));
      return;
    }
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "Session", extensions: ["jsonl"] }],
        title: t(lang, "importSession"),
      });
      if (typeof selected !== "string") return;
      const next = await importSession(selected, selectedWorkspace.path);
      applyPayload(next, selectedWorkspace.path);
      setToast(t(lang, "imported"));
    } catch (error) {
      showError(errorMessage(error));
    }
  }, [applyPayload, lang, selectedWorkspace?.path, showError]);

  const closeTab = useCallback(
    (terminalId: string) => {
      void closeTerminal(terminalId).catch((error) => showError(errorMessage(error)));
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === terminalId);
        const remaining = current.filter((tab) => tab.id !== terminalId);
        setActiveTabId((active) => {
          if (active !== terminalId) return active;
          return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null;
        });
        return remaining;
      });
    },
    [showError],
  );

  const handleExit = useCallback(
    (event: PtyExitEvent) => {
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
      if (event.success) {
        void checkOmpUpdate()
          .then(setUpdateInfo)
          .catch(() => undefined);
        void refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
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
        <div className="splash-logo">
          <Icon name="logo" size={58} />
        </div>
        <h1>OMP Desktop</h1>
        {refreshing ? (
          <p>
            <span className="loading-dot" /> {t("ru", "loading")}
          </p>
        ) : (
          <>
            <p className="splash-error">{startupError ?? t("ru", "loadError")}</p>
            <button className="button primary" onClick={() => void refresh()} type="button">
              <Icon name="refresh" /> {t("ru", "retry")}
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
          <span className="brand-mark">
            <Icon name="logo" size={26} />
          </span>
          <strong>OMP</strong>
          <span>Desktop</span>
        </div>
        <div className="topbar-context">
          <Icon name="folder" size={15} />
          <span>{selectedWorkspace?.name ?? t(lang, "projectNotSelected")}</span>
          {selectedWorkspace && <small>{selectedWorkspace.path}</small>}
        </div>
        <div className="topbar-actions">
          <button
            className={`runtime-pill ${payload.runtime.ompAvailable ? "is-ready" : "is-error"}`}
            onClick={() => setSettingsOpen(true)}
            type="button"
          >
            <span />
            {payload.runtime.ompVersion ?? t(lang, "notFound")}
          </button>
          {updateInfo?.hasUpdate && (
            <button
              className="button secondary update-pill"
              onClick={() => void launchUpdate()}
              title={updateInfo.message}
              type="button"
            >
              <Icon name="spark" size={14} />
              {t(lang, "updateNow")}
              {updateInfo.latestVersion ? ` ${updateInfo.latestVersion}` : ""}
            </button>
          )}
          <button
            className={`icon-button${refreshing ? " is-spinning" : ""}`}
            disabled={refreshing}
            onClick={() => void refresh()}
            title={t(lang, "refresh")}
            type="button"
          >
            <Icon name="refresh" />
          </button>
          <button
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            title={t(lang, "settings")}
            type="button"
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className="workbench">
        <aside className="project-rail">
          <div className="section-title">
            <span>{t(lang, "projects")}</span>
            <button onClick={() => void openFolder()} title={t(lang, "btnOpenFolder")} type="button">
              <Icon name="plus" size={16} />
            </button>
          </div>
          <nav className="project-list" aria-label={t(lang, "projects")}>
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
                    <small>
                      {workspace.sessionCount} {t(lang, "sessShort")}
                    </small>
                  </span>
                  {workspace.pinned && <span className="pin-dot" title="pinned" />}
                </button>
              );
            })}
          </nav>
          <button className="open-project-button" onClick={() => void openFolder()} type="button">
            <Icon name="folderOpen" size={16} />
            {t(lang, "btnOpenFolder")}
          </button>
          <div className="rail-footer">
            <Icon name="command" size={15} />
            <span>Ctrl + N</span>
            <small>{t(lang, "newSessionShortcut")}</small>
          </div>
        </aside>

        <aside className="session-sidebar">
          <div className="session-header">
            <div className="session-project-row">
              <div>
                <span className="eyebrow">{t(lang, "sessions")}</span>
                <h2>{selectedWorkspace?.name ?? t(lang, "noProject")}</h2>
              </div>
              <div className="session-header-actions">
                {selectedWorkspace && (
                  <>
                    <button
                      className="icon-button compact"
                      onClick={() => void openCodexImport()}
                      title={t(lang, "importCodex")}
                      type="button"
                    >
                      <Icon name="history" size={15} />
                    </button>
                    <button
                      className="icon-button compact"
                      onClick={() => void importOmpFile()}
                      title={t(lang, "importSession")}
                      type="button"
                    >
                      <Icon name="plus" size={15} />
                    </button>
                    <button
                      className="icon-button compact"
                      onClick={() => reveal(selectedWorkspace.path)}
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
              disabled={!selectedWorkspace || launching !== null || !payload.runtime.ompAvailable}
              onClick={() => void launchSession()}
              type="button"
            >
              <Icon name="plus" size={16} />
              {launching === "new" ? t(lang, "launching") : t(lang, "btnNewSession")}
            </button>
            <label className="search-box">
              <Icon name="search" size={15} />
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(lang, "searchSessions")}
                value={search}
              />
              {search && (
                <button onClick={() => setSearch("")} title={t(lang, "clearSearch")} type="button">
                  <Icon name="close" size={13} />
                </button>
              )}
            </label>
          </div>

          <div className="session-list">
            {visibleSessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const busy = launching === session.id;
              const renaming = session.id === renamingSessionId;

              const submitRename = () => {
                if (!renaming) return;
                setRenamingSessionId(null);
                const trimmed = renameValue.trim();
                if (trimmed && trimmed !== session.title) {
                  void renameSession(session.filePath, trimmed)
                    .then((next) => applyPayload(next))
                    .catch((error) => showError(errorMessage(error)));
                }
              };

              const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRenamingSessionId(null);
                }
              };

              return (
                <article className={`session-item${selected ? " is-selected" : ""}`} key={session.id}>
                  <div className="session-select" onDoubleClick={() => void launchSession(session)}>
                    <span className="session-icon">
                      <Icon name="history" size={16} />
                    </span>
                    <span
                      className="session-copy"
                      onClick={() => setSelectedSessionId(session.id)}
                      role="presentation"
                    >
                      {renaming ? (
                        <input
                          autoFocus
                          className="session-rename"
                          onBlur={submitRename}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          value={renameValue}
                        />
                      ) : (
                        <strong>{session.title}</strong>
                      )}
                      <small>
                        {formatRelative(session.updatedAt, lang)}
                        <i>·</i>
                        {session.model?.split("/").at(-1) ?? t(lang, "noModel")}
                        {session.source !== "omp" ? <i>· {session.source}</i> : null}
                      </small>
                    </span>
                  </div>
                  {!renaming && (
                    <button
                      className="session-play"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameValue(session.title);
                        setRenamingSessionId(session.id);
                      }}
                      title={t(lang, "rename")}
                      type="button"
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  )}
                  {!renaming && (
                    <button
                      className="session-play"
                      disabled={launching !== null || !payload.runtime.ompAvailable}
                      onClick={() => void launchSession(session)}
                      title={t(lang, "resumeSession")}
                      type="button"
                    >
                      {busy ? <span className="mini-loader" /> : <Icon name="play" size={14} />}
                    </button>
                  )}
                </article>
              );
            })}
            {selectedWorkspace && visibleSessions.length === 0 && (
              <div className="sidebar-empty">
                <Icon name={search ? "search" : "history"} />
                <strong>{search ? t(lang, "nothingFound") : t(lang, "historyEmpty")}</strong>
                <span>{search ? t(lang, "tryAnotherQuery") : t(lang, "createFirstSession")}</span>
              </div>
            )}
          </div>
          <div className="session-footer">
            <span>
              {workspaceSessions.length} {t(lang, "sessions").toLowerCase()}
            </span>
            <small>{t(lang, "jsonlNative")}</small>
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
                        title={tab.status === "running" ? t(lang, "stopAndClose") : t(lang, "close")}
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
                    title={t(lang, "btnNewSession")}
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
              lang={lang}
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

      {codexOpen && (
        <div className="settings-backdrop" onMouseDown={() => setCodexOpen(false)} role="presentation">
          <section
            className="settings-panel codex-import-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="settings-header">
              <div>
                <span className="eyebrow">Codex</span>
                <h2>{t(lang, "codexImportTitle")}</h2>
              </div>
              <button className="icon-button" onClick={() => setCodexOpen(false)} type="button">
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-scroll">
              {codexLoading ? (
                <p className="field-help">{t(lang, "loading")}</p>
              ) : codexSessions.length === 0 ? (
                <p className="field-help">{t(lang, "noCodexSessions")}</p>
              ) : (
                <div className="codex-list">
                  {codexSessions.map((session) => (
                    <label className="codex-item" key={session.filePath}>
                      <input
                        checked={Boolean(codexSelected[session.filePath])}
                        onChange={(event) =>
                          setCodexSelected((current) => ({
                            ...current,
                            [session.filePath]: event.target.checked,
                          }))
                        }
                        type="checkbox"
                      />
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          {session.cwd} · {formatRelative(session.updatedAt, lang)}
                          {session.model ? ` · ${session.model}` : ""}
                        </small>
                        {session.preview && <em>{session.preview}</em>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <footer className="settings-actions">
              <button
                className="button secondary"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  for (const session of codexSessions) next[session.filePath] = true;
                  setCodexSelected(next);
                }}
                type="button"
              >
                {t(lang, "selectAll")}
              </button>
              <button
                className="button primary"
                disabled={importing || Object.values(codexSelected).every((value) => !value)}
                onClick={() => void importCodexSelected()}
                type="button"
              >
                {importing ? t(lang, "saving") : t(lang, "importSelected")}
              </button>
            </footer>
          </section>
        </div>
      )}

      {toast && (
        <div className="error-toast" role="alert">
          <Icon name="alert" size={17} />
          <span>{toast}</span>
          <button onClick={() => setToast(null)} title={t(lang, "close")} type="button">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;

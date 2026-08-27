import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { RuntimeInfo, SessionSummary, WorkspaceSummary } from "./types"
import { formatRelative } from "./uiUtils"

interface WorkspaceHomeProps {
  workspace: WorkspaceSummary | null
  sessions: SessionSummary[]
  selectedSession: SessionSummary | null
  runtime: RuntimeInfo
  launching: string | null
  lang: Lang
  onLaunch: (session?: SessionSummary) => void
  onReveal: (path: string) => void
  onOpenFolder: () => void
}

export function WorkspaceHome({
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
    )
  }

  const latest = sessions[0] ?? null
  const focusSession = selectedSession ?? latest
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
  )
}

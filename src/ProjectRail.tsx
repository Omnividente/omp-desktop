import { Icon } from "./Icon";
import { t } from "./i18n";
import { SessionList, type SessionListProps } from "./SessionList";
import type { WorkspaceSummary } from "./types";
import { normalizedPath } from "./uiUtils";

interface ProjectRailProps {
  workspaces: WorkspaceSummary[];
  selectedWorkspace: WorkspaceSummary | null;
  platform: string;
  sessionList: SessionListProps;
  onOpenFolder: () => void;
  onSelectWorkspace: (path: string) => void;
}

export function ProjectRail({
  workspaces,
  selectedWorkspace,
  platform,
  sessionList,
  onOpenFolder,
  onSelectWorkspace,
}: ProjectRailProps) {
  const { lang } = sessionList;
  return (
    <aside className="project-rail">
      <div className="section-title">
        <span>{t(lang, "projects")}</span>
        <button onClick={onOpenFolder} title={t(lang, "btnOpenFolder")} type="button">
          <Icon name="plus" size={16} />
        </button>
      </div>
      <nav className="project-list" aria-label={t(lang, "projects")}>
        {workspaces.map((workspace) => {
          const active = selectedWorkspace
            ? normalizedPath(workspace.path, platform) ===
              normalizedPath(selectedWorkspace.path, platform)
            : false;
          return (
            <button
              aria-expanded={active}
              className={`project-item${active ? " is-active is-expanded" : ""}`}
              key={normalizedPath(workspace.path, platform)}
              onClick={() => onSelectWorkspace(workspace.path)}
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
              <span aria-hidden="true" className="project-expand-marker">
                <Icon name="chevron" size={13} />
              </span>
              {workspace.pinned && <span className="pin-dot" title="pinned" />}
            </button>
          );
        })}
      </nav>
      <SessionList {...sessionList} />
      <button className="open-project-button" onClick={onOpenFolder} type="button">
        <Icon name="folderOpen" size={16} />
        {t(lang, "btnOpenFolder")}
      </button>
      <div className="rail-footer">
        <Icon name="command" size={15} />
        <span>Ctrl + N</span>
        <small>{t(lang, "newSessionShortcut")}</small>
      </div>
    </aside>
  );
}

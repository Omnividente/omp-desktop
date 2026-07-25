import { Icon } from "./Icon";
import { t, type Lang } from "./i18n";
import type { OmpUpdateInfo, RuntimeInfo, WorkspaceSummary } from "./types";

interface TopbarProps {
  appVersion: string;
  checkingUpdate: boolean;
  language: Lang;
  refreshing: boolean;
  runtime: RuntimeInfo;
  selectedWorkspace: WorkspaceSummary | null;
  updateInfo: OmpUpdateInfo | null;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onUpdate: () => void;
}

export function Topbar({
  appVersion,
  checkingUpdate,
  language,
  refreshing,
  runtime,
  selectedWorkspace,
  updateInfo,
  onOpenSettings,
  onRefresh,
  onUpdate,
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="logo" size={26} />
        </span>
        <strong>OMP</strong>
        <span className="brand-product">Desktop</span>
        <span className="app-version" title={`OMP Desktop ${appVersion}`}>
          v{appVersion}
        </span>
      </div>
      <div className="topbar-context">
        <Icon name="folder" size={15} />
        <span>{selectedWorkspace?.name ?? t(language, "projectNotSelected")}</span>
        {selectedWorkspace && <small>{selectedWorkspace.path}</small>}
      </div>
      <div className="topbar-actions">
        <button
          className={`runtime-pill ${runtime.ompAvailable ? "is-ready" : "is-error"}`}
          onClick={onOpenSettings}
          type="button"
        >
          <span />
          {runtime.ompVersion ?? t(language, "notFound")}
        </button>
        {checkingUpdate && (
          <span aria-live="polite" className="update-check-pill">
            <span className="mini-loader" />
            {t(language, "updateChecking")}
          </span>
        )}
        {updateInfo?.hasUpdate && (
          <button
            className="button secondary update-pill"
            onClick={onUpdate}
            title={updateInfo.message}
            type="button"
          >
            <Icon name="spark" size={14} />
            {t(language, "updateNow")}
            {updateInfo.latestVersion ? ` ${updateInfo.latestVersion}` : ""}
          </button>
        )}
        <button
          className={`icon-button${refreshing ? " is-spinning" : ""}`}
          disabled={refreshing}
          onClick={onRefresh}
          title={t(language, "refresh")}
          type="button"
        >
          <Icon name="refresh" />
        </button>
        <button
          className="icon-button"
          onClick={onOpenSettings}
          title={t(language, "settings")}
          type="button"
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}

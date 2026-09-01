import { Icon } from "./Icon"
import type { Lang } from "./i18n"
import { t } from "./i18n"
import type { ClientUpdateInfo } from "./clientUpdater"
import "./ClientUpdateNotice.css"

interface ClientUpdateNoticeProps {
  language: Lang
  info: ClientUpdateInfo
  installing: boolean
  onInstall: () => void
  onRemindLater: () => void
  onViewChanges: () => void
}

export function ClientUpdateNotice({
  language,
  info,
  installing,
  onInstall,
  onRemindLater,
  onViewChanges,
}: ClientUpdateNoticeProps) {
  return (
    <aside className="client-update-notice" role="status">
      <div>
        <strong>{t(language, "desktopUpdateAvailable")}</strong>
        <span>{t(language, "desktopUpdateVersion").replace("{version}", info.version)}</span>
        {info.body ? <small>{info.body}</small> : null}
        <button className="release-notes-link" onClick={onViewChanges} type="button">
          {t(language, "viewChanges")}
          <Icon name="external" size={11} />
        </button>
      </div>
      <div className="client-update-actions">
        <button className="button primary" disabled={installing} onClick={onInstall} type="button">
          {installing
            ? t(language, "desktopUpdateInstalling")
            : t(language, "desktopUpdateInstall")}
        </button>
        <button
          className="button secondary"
          disabled={installing}
          onClick={onRemindLater}
          type="button"
        >
          {t(language, "updateRemindLater")}
        </button>
        <button
          aria-label={t(language, "close")}
          className="icon-button compact"
          disabled={installing}
          onClick={onRemindLater}
          title={t(language, "close")}
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </aside>
  )
}

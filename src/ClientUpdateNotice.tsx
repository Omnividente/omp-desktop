import type { Lang } from "./i18n"
import { t } from "./i18n"
import type { ClientUpdateInfo } from "./clientUpdater"
import "./ClientUpdateNotice.css"

interface ClientUpdateNoticeProps {
  language: Lang
  info: ClientUpdateInfo
  installing: boolean
  onInstall: () => void
  onClose: () => void
}

export function ClientUpdateNotice({
  language,
  info,
  installing,
  onInstall,
  onClose,
}: ClientUpdateNoticeProps) {
  return (
    <aside className="client-update-notice" role="status">
      <div>
        <strong>{t(language, "desktopUpdateAvailable")}</strong>
        <span>{t(language, "desktopUpdateVersion").replace("{version}", info.version)}</span>
        {info.body ? <small>{info.body}</small> : null}
      </div>
      <div className="client-update-actions">
        <button className="button primary" disabled={installing} onClick={onInstall} type="button">
          {installing
            ? t(language, "desktopUpdateInstalling")
            : t(language, "desktopUpdateInstall")}
        </button>
        <button
          className="icon-button compact"
          disabled={installing}
          onClick={onClose}
          type="button"
        >
          {t(language, "close")}
        </button>
      </div>
    </aside>
  )
}

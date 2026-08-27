import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { OmpUpdateInfo } from "./types"

interface UpdateNoticeProps {
  info: OmpUpdateInfo
  language: Lang
  disabled: boolean
  onRemindLater: () => void
  onDismissSession?: () => void
  onUpdate: () => void
}

export function UpdateNotice({
  info,
  language,
  disabled,
  onRemindLater,
  onDismissSession,
  onUpdate,
}: UpdateNoticeProps) {
  return (
    <div className="update-toast" role="status">
      <Icon name="spark" size={18} />
      <div>
        <strong>{t(language, "updateToastTitle")}</strong>
        <span>
          {t(language, "updateToastBody")
            .replace("{current}", info.currentVersion ?? t(language, "notFound"))
            .replace("{latest}", info.latestVersion ?? t(language, "updateAvailable"))}
        </span>
      </div>
      <button className="button primary" disabled={disabled} onClick={onUpdate} type="button">
        {t(language, "updateNow")}
      </button>
      <button
        className="button secondary"
        disabled={disabled}
        onClick={onRemindLater}
        type="button"
      >
        {t(language, "updateRemindLater")}
      </button>
      <button
        aria-label={t(language, onDismissSession ? "updateDismissSession" : "close")}
        className="update-toast-close"
        onClick={onDismissSession ?? onRemindLater}
        title={t(language, onDismissSession ? "updateDismissSession" : "close")}
        type="button"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

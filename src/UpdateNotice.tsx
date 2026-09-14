import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"

interface UpdateNoticeProps {
  title: string
  message: string
  actionLabel: string
  language: Lang
  disabled: boolean
  onRemindLater: () => void
  onDismissSession?: () => void
  onViewChanges?: () => void
  onUpdate: () => void
}

export function UpdateNotice({
  title,
  message,
  actionLabel,
  language,
  disabled,
  onRemindLater,
  onDismissSession,
  onUpdate,
  onViewChanges,
}: UpdateNoticeProps) {
  return (
    <aside className="update-toast" role="status">
      <Icon name="spark" size={18} />
      <div className="update-toast-content">
        <strong>{title}</strong>
        <span>{message}</span>
        {onViewChanges && (
          <button className="release-notes-link" onClick={onViewChanges} type="button">
            {t(language, "viewChanges")}
            <Icon name="external" size={11} />
          </button>
        )}
      </div>
      <div className="update-toast-actions">
        <button className="button primary" disabled={disabled} onClick={onUpdate} type="button">
          {actionLabel}
        </button>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={onRemindLater}
          type="button"
        >
          {t(language, "updateRemindLater")}
        </button>
      </div>
      <button
        aria-label={t(language, onDismissSession ? "updateDismissSession" : "close")}
        className="update-toast-close"
        onClick={onDismissSession ?? onRemindLater}
        disabled={disabled}
        title={t(language, onDismissSession ? "updateDismissSession" : "close")}
        type="button"
      >
        <Icon name="close" size={14} />
      </button>
    </aside>
  )
}

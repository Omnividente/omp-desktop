import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { SettingsUnavailableDetails } from "./types"

interface SettingsRecoveryScreenProps {
  busy: boolean
  language: Lang
  recovery: SettingsUnavailableDetails
  onOpenFolder: () => void
  onRetry: () => void
  onStartWithDefaults: () => void
}

export function SettingsRecoveryScreen({
  busy,
  language,
  recovery,
  onOpenFolder,
  onRetry,
  onStartWithDefaults,
}: SettingsRecoveryScreenProps) {
  return (
    <main
      className="splash-screen settings-recovery-screen"
      aria-labelledby="settings-recovery-title"
    >
      <section className="settings-recovery-card">
        <div className="settings-recovery-icon" aria-hidden="true">
          <Icon name="alert" size={30} />
        </div>
        <div>
          <h1 id="settings-recovery-title">{t(language, "settingsRecoveryTitle")}</h1>
          <p className="settings-recovery-description">
            {t(language, "settingsRecoveryDescription")}
          </p>
        </div>
        <dl className="settings-recovery-details">
          <div>
            <dt>{t(language, "settingsPath")}</dt>
            <dd>
              <code title={recovery.settingsPath}>{recovery.settingsPath}</code>
            </dd>
          </div>
          {recovery.backupPath && (
            <div>
              <dt>{t(language, "settingsBackupPath")}</dt>
              <dd>
                <code title={recovery.backupPath}>{recovery.backupPath}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>{t(language, "settingsFailureStage")}</dt>
            <dd>
              <code>{recovery.failureStage}</code>
            </dd>
          </div>
          {recovery.details && (
            <div>
              <dt>{t(language, "settingsFailureReason")}</dt>
              <dd>{recovery.details}</dd>
            </div>
          )}
        </dl>
        <div className="settings-recovery-actions">
          <button className="button" disabled={busy} onClick={onOpenFolder} type="button">
            <Icon name="folderOpen" /> {t(language, "openSettingsFolder")}
          </button>
          <button className="button" disabled={busy} onClick={onRetry} type="button">
            <Icon name="refresh" /> {t(language, "retry")}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={onStartWithDefaults}
            type="button"
          >
            <Icon name="settings" /> {t(language, "startWithDefaults")}
          </button>
        </div>
      </section>
    </main>
  )
}

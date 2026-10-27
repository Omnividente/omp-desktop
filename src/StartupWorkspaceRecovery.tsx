import { useRef } from "react"
import { t, type Lang } from "./i18n"
import type { StartupWorkspaceWarning } from "./types"
import { useModalFocus } from "./useModalFocus"

interface Props {
  warning: StartupWorkspaceWarning
  fallbackPath: string | null
  language: Lang
  busy: boolean
  error: string | null
  onRetry: () => void
  onChoose: () => void
  onContinue: () => void
}

export function StartupWorkspaceRecovery({
  warning,
  fallbackPath,
  language,
  busy,
  error,
  onRetry,
  onChoose,
  onContinue,
}: Props) {
  const panel = useRef<HTMLElement>(null)
  // Escape/backdrop dismissal would silently accept an unrelated project.
  const onKeyDown = useModalFocus(panel, () => undefined, { canClose: false })
  return (
    <div className="settings-backdrop" role="presentation">
      <section
        className="settings-panel codex-import-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="startup-workspace-title"
        aria-describedby="startup-workspace-description"
        ref={panel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="settings-header">
          <h2 id="startup-workspace-title">{t(language, "startupWorkspaceTitle")}</h2>
        </header>
        <div className="settings-scroll">
          <p id="startup-workspace-description">{t(language, "startupWorkspaceDescription")}</p>
          <dl className="settings-recovery-details">
            <div>
              <dt>{t(language, "startupWorkspaceRequested")}</dt>
              <dd>
                <code>{warning.requestedPath}</code>
              </dd>
            </div>
            <div>
              <dt>{t(language, "startupWorkspaceFallback")}</dt>
              <dd>
                <code>{fallbackPath ?? t(language, "startupWorkspaceEmpty")}</code>
              </dd>
            </div>
          </dl>
          <p>{warning.message}</p>
          {error && <p role="alert">{error}</p>}
        </div>
        <footer className="settings-actions">
          <button
            className="button"
            type="button"
            data-startup-action="retry"
            disabled={busy}
            onClick={onRetry}
          >
            {t(language, "retry")}
          </button>
          <button
            className="button"
            type="button"
            data-startup-action="choose"
            disabled={busy}
            onClick={onChoose}
          >
            {t(language, "startupWorkspaceChoose")}
          </button>
          <button
            className="button primary"
            type="button"
            data-startup-action="continue"
            disabled={busy}
            onClick={onContinue}
          >
            {t(language, "startupWorkspaceContinue")}
          </button>
        </footer>
      </section>
    </div>
  )
}

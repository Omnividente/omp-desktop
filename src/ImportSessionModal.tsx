import { Icon } from "./Icon"
import { ImportModeSelect } from "./ImportModeSelect"
import { t, type Lang } from "./i18n"
import type { ImportMode } from "./types"

interface ImportSessionModalProps {
  importing: boolean
  language: Lang
  mode: ImportMode
  path: string
  onClose: () => void
  onImport: () => void
  onModeChange: (mode: ImportMode) => void
}

export function ImportSessionModal({
  importing,
  language,
  mode,
  path,
  onClose,
  onImport,
  onModeChange,
}: ImportSessionModalProps) {
  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="omp-import-title"
        aria-modal="true"
        className="settings-panel codex-import-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">OMP</span>
            <h2 id="omp-import-title">{t(language, "importSessionTitle")}</h2>
          </div>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            disabled={importing}
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="settings-scroll">
          <p className="field-help">{path}</p>
          <ImportModeSelect
            disabled={importing}
            language={language}
            mode={mode}
            onChange={onModeChange}
          />
        </div>
        <footer className="settings-actions">
          <button className="button secondary" disabled={importing} onClick={onClose} type="button">
            {t(language, "cancel")}
          </button>
          <button className="button primary" disabled={importing} onClick={onImport} type="button">
            {importing ? t(language, "saving") : t(language, "importFile")}
          </button>
        </footer>
      </section>
    </div>
  )
}

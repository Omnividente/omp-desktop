import { Icon } from "./Icon";
import { t, type Lang } from "./i18n";
import type { CodexSessionSummary } from "./types";
import { formatRelative } from "./uiUtils";

interface CodexImportModalProps {
  language: Lang;
  loading: boolean;
  importing: boolean;
  sessions: CodexSessionSummary[];
  selected: Record<string, boolean>;
  onClose: () => void;
  onImport: () => void;
  onSelectedChange: (selected: Record<string, boolean>) => void;
}

export function CodexImportModal({
  language,
  loading,
  importing,
  sessions,
  selected,
  onClose,
  onImport,
  onSelectedChange,
}: CodexImportModalProps) {
  const selectAll = () => {
    onSelectedChange(Object.fromEntries(sessions.map((session) => [session.filePath, true])));
  };

  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="codex-import-title"
        aria-modal="true"
        className="settings-panel codex-import-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">Codex</span>
            <h2 id="codex-import-title">{t(language, "codexImportTitle")}</h2>
          </div>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="settings-scroll">
          {loading ? (
            <p className="field-help">{t(language, "loading")}</p>
          ) : sessions.length === 0 ? (
            <p className="field-help">{t(language, "noCodexSessions")}</p>
          ) : (
            <div className="codex-list">
              {sessions.map((session) => (
                <label className="codex-item" key={session.filePath}>
                  <input
                    checked={Boolean(selected[session.filePath])}
                    onChange={(event) =>
                      onSelectedChange({
                        ...selected,
                        [session.filePath]: event.target.checked,
                      })
                    }
                    type="checkbox"
                  />
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {session.cwd} · {formatRelative(session.updatedAt, language)}
                      {session.model ? ` · ${session.model}` : ""}
                    </small>
                    {session.preview && <em>{session.preview}</em>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <footer className="settings-actions">
          <button className="button secondary" onClick={selectAll} type="button">
            {t(language, "selectAll")}
          </button>
          <button
            className="button primary"
            disabled={importing || Object.values(selected).every((value) => !value)}
            onClick={onImport}
            type="button"
          >
            {importing ? t(language, "saving") : t(language, "importSelected")}
          </button>
        </footer>
      </section>
    </div>
  );
}

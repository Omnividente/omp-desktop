import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage, updateSettings } from "./api";
import { Icon } from "./Icon";
import type {
  AppSettings,
  BootstrapPayload,
  RuntimeInfo,
} from "./types";

interface SettingsPanelProps {
  settings: AppSettings;
  runtime: RuntimeInfo;
  onClose: () => void;
  onSaved: (payload: BootstrapPayload) => void;
  onError: (message: string) => void;
}

export function SettingsPanel({
  settings,
  runtime,
  onClose,
  onSaved,
  onError,
}: SettingsPanelProps) {
  const [executable, setExecutable] = useState(settings.ompExecutable ?? "");
  const [sessionRoot, setSessionRoot] = useState(settings.sessionRoot ?? "");
  const [saving, setSaving] = useState(false);

  const chooseExecutable = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: "Выберите исполняемый файл OMP",
      });
      if (typeof selected === "string") {
        setExecutable(selected);
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const chooseSessionRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Выберите папку сессий OMP",
      });
      if (typeof selected === "string") {
        setSessionRoot(selected);
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = await updateSettings({
        ompExecutable: executable.trim() || null,
        sessionRoot: sessionRoot.trim() || null,
      });
      onSaved(payload);
      onClose();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">Конфигурация</span>
            <h2 id="settings-title">Настройки OMP</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Закрыть" type="button">
            <Icon name="close" />
          </button>
        </header>

        <div className={`runtime-card ${runtime.ompAvailable ? "is-ready" : "is-error"}`}>
          <span className="runtime-card-icon">
            <Icon name={runtime.ompAvailable ? "check" : "alert"} />
          </span>
          <div>
            <strong>{runtime.ompAvailable ? "OMP подключён" : "OMP не найден"}</strong>
            <span>
              {runtime.ompVersion ?? "Укажите путь к исполняемому файлу ниже"}
            </span>
          </div>
        </div>

        <div className="settings-fields">
          <label className="field-label" htmlFor="omp-executable">
            Исполняемый файл OMP
          </label>
          <div className="path-field">
            <input
              id="omp-executable"
              onChange={(event) => setExecutable(event.target.value)}
              placeholder={runtime.ompExecutable}
              spellCheck={false}
              value={executable}
            />
            <button onClick={chooseExecutable} type="button">
              <Icon name="folderOpen" size={16} />
              Обзор
            </button>
          </div>
          <p className="field-help">
            Оставьте пустым для автоматического поиска через PATH и стандартные папки.
          </p>

          <label className="field-label" htmlFor="session-root">
            Папка сессий
          </label>
          <div className="path-field">
            <input
              id="session-root"
              onChange={(event) => setSessionRoot(event.target.value)}
              placeholder={runtime.sessionRoot}
              spellCheck={false}
              value={sessionRoot}
            />
            <button onClick={chooseSessionRoot} type="button">
              <Icon name="folderOpen" size={16} />
              Обзор
            </button>
          </div>
          <p className="field-help">
            По умолчанию используется ~/.omp/agent/sessions или PI_CODING_AGENT_DIR.
          </p>
        </div>

        <div className="settings-meta">
          <span>Платформа</span>
          <strong>{runtime.platform} · {runtime.arch}</strong>
        </div>

        <footer className="settings-actions">
          <button className="button secondary" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="button primary" disabled={saving} onClick={save} type="button">
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </footer>
      </section>
    </div>
  );
}

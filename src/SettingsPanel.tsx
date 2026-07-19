import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  errorMessage,
  loadOmpConfig,
  saveOmpConfig,
  updateSettings,
} from "./api";
import { Icon } from "./Icon";
import {
  roleDescription,
  roleLabel,
  statusDescription,
  statusLabel,
  t,
  thinkingLevelLabel,
  type Lang,
} from "./i18n";
import { ModelPicker } from "./ModelPicker";
import type {
  AppSettings,
  BootstrapPayload,
  OmpConfigSnapshot,
  RuntimeInfo,
} from "./types";

interface SettingsPanelProps {
  settings: AppSettings;
  runtime: RuntimeInfo;
  onClose: () => void;
  onSaved: (payload: BootstrapPayload) => void;
  onError: (message: string) => void;
}

const ROLE_ORDER = [
  "default",
  "smol",
  "slow",
  "plan",
  "advisor",
  "task",
  "designer",
  "vision",
  "commit",
  "tiny",
  "consult",
];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

export function SettingsPanel({
  settings,
  runtime,
  onClose,
  onSaved,
  onError,
}: SettingsPanelProps) {
  const lang = (settings.language === "en" ? "en" : "ru") as Lang;
  const [executable, setExecutable] = useState(settings.ompExecutable ?? "");
  const [sessionRoot, setSessionRoot] = useState(settings.sessionRoot ?? "");
  const [language, setLanguage] = useState<Lang>(lang);
  const [saving, setSaving] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadingSlow, setLoadingSlow] = useState(false);
  const [ompConfig, setOmpConfig] = useState<OmpConfigSnapshot | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [advisorEnabled, setAdvisorEnabled] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState("medium");
  const [providerEnv, setProviderEnv] = useState<Record<string, string>>(
    settings.providerEnv ?? {},
  );
  const [newKeyName, setNewKeyName] = useState("OPENAI_API_KEY");
  const [newKeyValue, setNewKeyValue] = useState("");

  const refreshConfig = async () => {
    if (!runtime.ompAvailable) {
      return;
    }
    setLoadingConfig(true);
    setConfigError(null);
    try {
      const snapshot = await loadOmpConfig();
      setOmpConfig(snapshot);
      const drafts: Record<string, string> = {};
      for (const role of snapshot.roles) {
        drafts[role.role] = role.selector;
      }
      setRoleDrafts(drafts);
      setAdvisorEnabled(snapshot.advisorEnabled);
      setAutoResume(snapshot.autoResume);
      setThinkingLevel(snapshot.defaultThinkingLevel ?? "medium");
    } catch (error) {
      const message = errorMessage(error);
      setConfigError(message);
      onError(message);
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    void refreshConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.ompAvailable]);

  useEffect(() => {
    setProviderEnv(settings.providerEnv ?? {});
  }, [settings.providerEnv]);

  useEffect(() => {
    if (!loadingConfig) {
      setLoadingSlow(false);
      return;
    }
    const timeout = window.setTimeout(() => setLoadingSlow(true), 4_000);
    return () => window.clearTimeout(timeout);
  }, [loadingConfig]);

  const orderedRoles = useMemo(() => {
    if (!ompConfig) {
      return [];
    }
    const known = ROLE_ORDER
      .map((role) => ompConfig.roles.find((item) => item.role === role))
      .filter(Boolean);
    const rest = ompConfig.roles.filter((role) => !ROLE_ORDER.includes(role.role));
    return [...known, ...rest] as typeof ompConfig.roles;
  }, [ompConfig]);


  const chooseExecutable = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t(language, "executableLabel"),
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
        title: t(language, "sessionRootLabel"),
      });
      if (typeof selected === "string") {
        setSessionRoot(selected);
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const addProviderKey = () => {
    const key = newKeyName.trim();
    const value = newKeyValue.trim();
    if (!key || !value) {
      return;
    }
    setProviderEnv((current) => ({ ...current, [key]: value }));
    setNewKeyValue("");
  };

  const save = async () => {
    setSaving(true);
    try {
      if (runtime.ompAvailable && ompConfig) {
        const snapshot = await saveOmpConfig({
          roles: roleDrafts,
          advisorEnabled,
          autoResume,
          defaultThinkingLevel: thinkingLevel,
          providerEnv,
        });
        setOmpConfig(snapshot);
      }
      const payload = await updateSettings({
        ompExecutable: executable.trim() || null,
        sessionRoot: sessionRoot.trim() || null,
        language,
        providerEnv,
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
            <span className="eyebrow">{t(language, "configuration")}</span>
            <h2 id="settings-title">{t(language, "settingsTitle")}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            title={t(language, "close")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className={`runtime-card ${runtime.ompAvailable ? "is-ready" : "is-error"}`}>
          <span className="runtime-card-icon">
            <Icon name={runtime.ompAvailable ? "check" : "alert"} />
          </span>
          <div>
            <strong>
              {runtime.ompAvailable
                ? t(language, "ompConnected")
                : t(language, "ompMissing")}
            </strong>
            <span>{runtime.ompVersion ?? t(language, "ompPathHelp")}</span>
          </div>
          {runtime.ompAvailable && (
            <button
              className="button secondary"
              disabled={loadingConfig}
              onClick={() => void refreshConfig()}
              type="button"
            >
              {loadingConfig ? (
                <>
                  <span aria-hidden="true" className="mini-loader" />
                  {t(language, "refreshingModels")}
                </>
              ) : (
                t(language, "refreshModels")
              )}
            </button>
          )}
        </div>

        {loadingConfig && (
          <div
            aria-atomic="true"
            aria-live="polite"
            className={`settings-loading-banner${loadingSlow ? " is-slow" : ""}`}
            data-testid="omp-settings-loading"
            role="status"
          >
            <span aria-hidden="true" className="settings-loading-orbit">
              <Icon name={loadingSlow ? "clock" : "spark"} size={16} />
            </span>
            <span className="settings-loading-copy">
              <strong>
                {t(language, loadingSlow ? "loadingSlowTitle" : "loadingBannerTitle")}
              </strong>
              <small>
                {t(language, loadingSlow ? "loadingSlowBody" : "loadingBannerBody")}
              </small>
            </span>
            <span aria-hidden="true" className="settings-loading-progress">
              <span />
            </span>
          </div>
        )}

        <div className="settings-scroll">
          <div className="settings-fields">
            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <span className="eyebrow">{t(language, "interfaceSection")}</span>
                  <p>{t(language, "interfaceSectionHelp")}</p>
                </div>
              </div>
              <label className="field-label" htmlFor="language-select">
                {t(language, "language")}
              </label>
              <div className="path-field select-field">
                <select
                  id="language-select"
                  onChange={(event) => setLanguage(event.target.value as Lang)}
                  value={language}
                >
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                </select>
                <Icon className="select-chevron" name="chevron" size={14} />
              </div>
              <p className="field-help">{t(language, "languageHelp")}</p>
            </section>

            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <span className="eyebrow">{t(language, "pathsSection")}</span>
                  <p>{t(language, "pathsSectionHelp")}</p>
                </div>
              </div>
              <label className="field-label" htmlFor="omp-executable">
                {t(language, "executableLabel")}
              </label>
              <div className="path-field">
                <input
                  id="omp-executable"
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder={runtime.ompExecutable}
                  spellCheck={false}
                  value={executable}
                />
                <button onClick={() => void chooseExecutable()} type="button">
                  <Icon name="folderOpen" size={16} />
                  {t(language, "browse")}
                </button>
              </div>
              <p className="field-help">{t(language, "executableHelp")}</p>

              <label className="field-label" htmlFor="session-root">
                {t(language, "sessionRootLabel")}
              </label>
              <div className="path-field">
                <input
                  id="session-root"
                  onChange={(event) => setSessionRoot(event.target.value)}
                  placeholder={runtime.sessionRoot}
                  spellCheck={false}
                  value={sessionRoot}
                />
                <button onClick={() => void chooseSessionRoot()} type="button">
                  <Icon name="folderOpen" size={16} />
                  {t(language, "browse")}
                </button>
              </div>
              <p className="field-help">{t(language, "sessionRootHelp")}</p>
            </section>

            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <span className="eyebrow">{t(language, "behaviorSection")}</span>
                  <p>{t(language, "behaviorSectionHelp")}</p>
                </div>
              </div>
              <div className="settings-options">
                <label className="toggle-row">
                  <input
                    checked={advisorEnabled}
                    onChange={(event) => setAdvisorEnabled(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{t(language, "advisorEnabled")}</strong>
                    <small>{t(language, "advisorHelp")}</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input
                    checked={autoResume}
                    onChange={(event) => setAutoResume(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{t(language, "autoResume")}</strong>
                    <small>{t(language, "autoResumeHelp")}</small>
                  </span>
                </label>
              </div>
              <label className="field-label" htmlFor="thinking-level">
                {t(language, "thinkingLevel")}
              </label>
              <div className="path-field select-field">
                <select
                  id="thinking-level"
                  onChange={(event) => setThinkingLevel(event.target.value)}
                  value={thinkingLevel}
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {thinkingLevelLabel(language, level)}
                    </option>
                  ))}
                </select>
                <Icon className="select-chevron" name="chevron" size={14} />
              </div>
              <p className="field-help">{t(language, "thinkingLevelHelp")}</p>
            </section>

            <section className="settings-section settings-models-section">
              <div className="settings-section-heading">
                <div>
                  <span className="eyebrow">{t(language, "modelRoles")}</span>
                  <p>{t(language, "modelRolesHelp")}</p>
                </div>
                {ompConfig && (
                  <span className="settings-count">
                    {ompConfig.models.length} {t(language, "modelsAvailable")}
                  </span>
                )}
              </div>

              {loadingConfig && !ompConfig && (
                <div aria-hidden="true" className="settings-role-skeletons">
                  {Array.from({ length: 3 }, (_, index) => (
                    <span className="settings-role-skeleton" key={index}>
                      <i />
                      <b />
                      <em />
                    </span>
                  ))}
                </div>
              )}
              {configError && !loadingConfig && !ompConfig && (
                <div className="settings-state is-error">
                  <Icon name="alert" size={16} />
                  <span>{t(language, "modelLoadFailed")}</span>
                  <button className="button secondary" onClick={() => void refreshConfig()} type="button">
                    {t(language, "retryModels")}
                  </button>
                </div>
              )}

              {ompConfig &&
                orderedRoles.map((role) => {
                  const draft = roleDrafts[role.role] ?? role.selector;
                  return (
                    <article className="role-row" key={role.role}>
                      <div className="role-head">
                        <div>
                          <strong>{roleLabel(language, role.role)}</strong>
                          <code title={t(language, "roleCode")}>{role.role}</code>
                        </div>
                        <span className={`role-status is-${role.status}`}>
                          {statusLabel(language, role.status)}
                        </span>
                      </div>
                      <p className="role-description">{roleDescription(language, role.role)}</p>
                      <ModelPicker
                        language={language}
                        models={ompConfig.models}
                        onChange={(selector) =>
                          setRoleDrafts((current) => ({ ...current, [role.role]: selector }))
                        }
                        onOpenChange={(open) => setOpenRole(open ? role.role : null)}
                        open={openRole === role.role}
                        role={role.role}
                        value={draft}
                      />
                      <p className={`role-health is-${role.status}`}>
                        {statusDescription(language, role.status)}
                      </p>
                    </article>
                  );
                })}
            </section>

            <section className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <span className="eyebrow">{t(language, "providerKeys")}</span>
                  <p>{t(language, "providerKeysHelp")}</p>
                </div>
              </div>
              {Object.entries(providerEnv)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => (
                  <div className="provider-key-row" key={key}>
                    <code>{key}</code>
                    <span>{value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "••••"}</span>
                    <button
                      className="button secondary"
                      onClick={() =>
                        setProviderEnv((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        })
                      }
                      type="button"
                    >
                      {t(language, "remove")}
                    </button>
                  </div>
                ))}
              <div className="provider-add-row">
                <input
                  onChange={(event) => setNewKeyName(event.target.value)}
                  placeholder={t(language, "keyName")}
                  spellCheck={false}
                  value={newKeyName}
                />
                <input
                  onChange={(event) => setNewKeyValue(event.target.value)}
                  placeholder={t(language, "keyValue")}
                  spellCheck={false}
                  type="password"
                  value={newKeyValue}
                />
                <button className="button secondary" onClick={addProviderKey} type="button">
                  {t(language, "addProviderKey")}
                </button>
              </div>
              {(ompConfig?.providerEnvKeys.length ?? 0) > 0 && (
                <div className="provider-key-suggestions">
                  <span>{t(language, "commonKeys")}</span>
                  <div>
                    {ompConfig?.providerEnvKeys.slice(0, 10).map((key) => (
                      <button key={key} onClick={() => setNewKeyName(key)} type="button">
                        {key}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="settings-meta">
          <span>{t(language, "platform")}</span>
          <strong>
            {runtime.platform} · {runtime.arch}
          </strong>
        </div>

        <footer className="settings-actions">
          <button className="button secondary" onClick={onClose} type="button">
            {t(language, "cancel")}
          </button>
          <button
            className="button primary"
            disabled={saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? t(language, "saving") : t(language, "save")}
          </button>
        </footer>
      </section>
    </div>
  );
}

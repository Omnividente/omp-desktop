import { useEffect, useMemo, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { errorMessage, loadOmpConfig, refreshOmpConfig, saveSettingsBundle } from "./api"
import { Icon } from "./Icon"
import {
  roleDescription,
  roleLabel,
  statusDescription,
  statusLabel,
  t,
  thinkingLevelLabel,
  type Lang,
} from "./i18n"
import { ModelPicker } from "./ModelPicker"
import type {
  AppSettings,
  BootstrapPayload,
  OmpConfigSnapshot,
  OmpAccountUsageInfo,
  OmpCredentialInfo,
  RuntimeInfo,
} from "./types"

interface SettingsPanelProps {
  settings: AppSettings
  runtime: RuntimeInfo
  onClose: () => void
  onSaved: (payload: BootstrapPayload) => void
  onConfigSaved?: (snapshot: OmpConfigSnapshot) => void
  onError: (message: string) => void
}

const USAGE_STALE_MS = 10 * 60_000
const USAGE_REFRESH_COOLDOWN_MS = 30_000
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]

type SettingsSection = "general" | "behavior" | "models" | "providers"

interface FallbackChainDraft {
  id: string
  key: string
  selectors: string[]
}

function serializeFallbackChains(
  drafts: FallbackChainDraft[],
  language: Lang,
): Record<string, string[]> {
  const chains: Record<string, string[]> = {}
  for (const draft of drafts) {
    const key = draft.key.trim()
    if (!key) {
      throw new Error(t(language, "fallbackEmptyKeyError"))
    }
    if (Object.hasOwn(chains, key)) {
      throw new Error(t(language, "fallbackDuplicateKeyError"))
    }
    const selectors = draft.selectors.map((selector) => selector.trim())
    if (selectors.length === 0 || selectors.some((selector) => !selector)) {
      throw new Error(t(language, "fallbackEmptyModelError"))
    }
    chains[key] = selectors
  }
  return chains
}

function fallbackChainsEqual(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        left[key].length === right[key].length &&
        left[key].every((selector, selectorIndex) => selector === right[key][selectorIndex]),
    )
  )
}
function credentialSourceLabel(language: Lang, source: OmpCredentialInfo["source"]): string {
  switch (source) {
    case "desktop":
      return t(language, "credentialSourceDesktop")
    case "environment":
      return t(language, "credentialSourceEnvironment")
    case "command":
      return t(language, "credentialSourceCommand")
    case "omp":
      return t(language, "credentialSourceOmp")
    default:
      return t(language, "credentialSourceModels")
  }
}

function credentialStatusLabel(language: Lang, credential: OmpCredentialInfo): string {
  if (credential.status === "limited" || credential.status === "exhausted") {
    return statusLabel(language, credential.status)
  }
  if (!credential.available || credential.status === "missing") {
    return t(language, "credentialMissing")
  }
  return t(
    language,
    credential.status === "ready" || credential.status === "ok"
      ? "credentialReady"
      : "credentialConfigured",
  )
}

function accountStatusLabel(language: Lang, status: OmpAccountUsageInfo["status"]): string {
  const key = {
    ready: "accountStatusReady",
    limited: "accountStatusLimited",
    exhausted: "accountStatusExhausted",
    unknown: "accountStatusUnknown",
    disabled: "accountStatusDisabled",
  }[status] as
    | "accountStatusReady"
    | "accountStatusLimited"
    | "accountStatusExhausted"
    | "accountStatusUnknown"
    | "accountStatusDisabled"
  return t(language, key)
}

function accountCredentialTypeLabel(
  language: Lang,
  type: OmpAccountUsageInfo["credentialType"],
): string {
  if (type === "oauth") return t(language, "accountCredentialOauth")
  if (type === "api_key") return t(language, "accountCredentialApiKey")
  return t(language, "accountCredentialUnknown")
}

function accountRoutingLabel(language: Lang, account: OmpAccountUsageInfo): string {
  if (account.routingEvidence === "usage") {
    return t(
      language,
      account.routingEligible ? "accountRoutingAllowedByLimits" : "accountRoutingBlockedByLimits",
    )
  }
  if (account.routingEvidence === "unknown") return t(language, "accountRoutingUnknown")
  return t(
    language,
    account.routingEligible ? "accountRoutingEligible" : "accountRoutingIneligible",
  )
}

function accountRouteStatusLabel(
  language: Lang,
  status: OmpAccountUsageInfo["routes"][number]["status"],
): string {
  if (status === "ready") return t(language, "accountStatusReady")
  if (status === "limited") return t(language, "accountStatusLimited")
  if (status === "exhausted") return t(language, "accountStatusExhausted")
  return t(language, "accountStatusUnknown")
}

function formatAccountCountdown(language: Lang, target: number, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((target - now) / 1_000))
  if (remainingSeconds === 0) return t(language, "accountCountdownNow")
  const days = Math.floor(remainingSeconds / 86_400)
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600)
  const minutes = Math.floor((remainingSeconds % 3_600) / 60)
  const seconds = remainingSeconds % 60
  const units = language === "en" ? ["d", "h", "m", "s"] : ["д", "ч", "м", "с"]
  if (days > 0) return `${days}${units[0]} ${hours}${units[1]}`
  if (hours > 0) return `${hours}${units[1]} ${minutes}${units[2]}`
  if (minutes > 0) return `${minutes}${units[2]} ${seconds}${units[3]}`
  return `${seconds}${units[3]}`
}

function formatAccountTimestamp(language: Lang, timestamp: number): string {
  return new Intl.DateTimeFormat(language === "en" ? "en" : "ru", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

function formatAccountPercent(language: Lang, percent: number): string {
  return new Intl.NumberFormat(language === "en" ? "en" : "ru", {
    maximumFractionDigits: 2,
  }).format(Math.min(100, Math.max(0, percent)))
}

function accountReasonLabel(language: Lang, reason: string): string {
  if (reason === "usage limits were not reported") return t(language, "accountReasonNotReported")
  if (reason === "credential disabled; sign in again") return t(language, "accountReasonDisabled")
  return reason
}

export function SettingsPanel({
  settings,
  runtime,
  onClose,
  onSaved,
  onConfigSaved,
  onError,
}: SettingsPanelProps) {
  const lang = (settings.language === "en" ? "en" : "ru") as Lang
  const [executable, setExecutable] = useState(settings.ompExecutable ?? "")
  const [sessionRoot, setSessionRoot] = useState(settings.sessionRoot ?? "")
  const [language, setLanguage] = useState<Lang>(lang)
  const [saving, setSaving] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [loadingSlow, setLoadingSlow] = useState(false)
  const [ompConfig, setOmpConfig] = useState<OmpConfigSnapshot | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0)
  const [openRole, setOpenRole] = useState<string | null>(null)
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({})
  const [advisorEnabled, setAdvisorEnabled] = useState(false)
  const [autoResume, setAutoResume] = useState(false)
  const [thinkingLevel, setThinkingLevel] = useState("medium")
  const [modelFallbackEnabled, setModelFallbackEnabled] = useState(true)
  const [fallbackChains, setFallbackChains] = useState<FallbackChainDraft[]>([])
  const [proxyProviders, setProxyProviders] = useState<string[]>([])
  const fallbackDraftSequence = useRef(0)
  const [appFontFamily, setAppFontFamily] = useState(settings.appFontFamily)
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    settings.terminalFontFamily ?? "monospace",
  )
  const [terminalFontSize, setTerminalFontSize] = useState(String(settings.terminalFontSize ?? 14))
  const [providerEnv, setProviderEnv] = useState<Record<string, string>>(() =>
    Object.fromEntries((settings.providerEnvKeys ?? []).map((key) => [key, ""])),
  )
  const [newKeyName, setNewKeyName] = useState("OPENAI_API_KEY")
  const [newKeyValue, setNewKeyValue] = useState("")
  const [activeSection, setActiveSection] = useState<SettingsSection>("general")

  const nextFallbackChainId = () => `fallback-chain-${fallbackDraftSequence.current++}`
  const fallbackDraftsFromSnapshot = (chains: Record<string, string[]>) =>
    Object.entries(chains).map(([key, selectors]) => ({
      id: nextFallbackChainId(),
      key,
      selectors,
    }))

  const refreshConfig = async (forceUsage = false) => {
    if (!runtime.ompAvailable) {
      return
    }
    setLoadingConfig(true)
    setConfigError(null)
    if (forceUsage) {
      const requestedAt = Date.now()
      setClockNow(requestedAt)
      setRefreshCooldownUntil(requestedAt + USAGE_REFRESH_COOLDOWN_MS)
    }
    try {
      const snapshot = forceUsage ? await refreshOmpConfig() : await loadOmpConfig()
      const loadedAt = Date.now()
      setOmpConfig(snapshot)
      const drafts: Record<string, string> = {}
      for (const role of snapshot.roles) {
        drafts[role.role] = role.selector
      }
      setRoleDrafts(drafts)
      setAdvisorEnabled(snapshot.advisorEnabled)
      setAutoResume(snapshot.autoResume)
      setThinkingLevel(snapshot.defaultThinkingLevel ?? "medium")
      setModelFallbackEnabled(snapshot.modelFallbackEnabled)
      setFallbackChains(fallbackDraftsFromSnapshot(snapshot.fallbackChains))
      setProxyProviders(snapshot.proxyProviders)
      setClockNow(loadedAt)
    } catch (error) {
      const message = errorMessage(error, language)
      setConfigError(message)
      onError(message)
    } finally {
      setLoadingConfig(false)
    }
  }

  useEffect(() => {
    void refreshConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.ompAvailable])

  useEffect(() => {
    setProviderEnv((current) =>
      Object.fromEntries((settings.providerEnvKeys ?? []).map((key) => [key, current[key] ?? ""])),
    )
  }, [settings.providerEnvKeys])

  useEffect(() => {
    if (!loadingConfig) {
      setLoadingSlow(false)
      return
    }
    const timeout = window.setTimeout(() => setLoadingSlow(true), 4_000)
    return () => window.clearTimeout(timeout)
  }, [loadingConfig])

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  const orderedRoles = ompConfig?.roles ?? []
  const credentials = ompConfig?.credentials ?? []
  const accounts = useMemo(() => ompConfig?.accounts ?? [], [ompConfig?.accounts])
  const accountGroups = useMemo(() => {
    const grouped = new Map<string, OmpAccountUsageInfo[]>()
    for (const account of accounts ?? []) {
      const providerAccounts = grouped.get(account.provider) ?? []
      providerAccounts.push(account)
      grouped.set(account.provider, providerAccounts)
    }
    return [...grouped.entries()].map(([provider, providerAccounts]) => ({
      provider,
      accounts: providerAccounts,
    }))
  }, [accounts])
  const usageAgeMs =
    ompConfig?.usageObservedAt === null || ompConfig?.usageObservedAt === undefined
      ? null
      : Math.max(0, clockNow - ompConfig.usageObservedAt)
  const usageIsStale = usageAgeMs !== null && usageAgeMs > USAGE_STALE_MS
  const refreshCooldownSeconds = Math.max(0, Math.ceil((refreshCooldownUntil - clockNow) / 1_000))

  const updateFallbackChain = (
    chainId: string,
    transform: (chain: FallbackChainDraft) => FallbackChainDraft,
  ) => {
    setFallbackChains((current) =>
      current.map((chain) => (chain.id === chainId ? transform(chain) : chain)),
    )
  }

  const addFallbackChain = () => {
    const usedKeys = new Set(fallbackChains.map((chain) => chain.key.trim()))
    const suggestedKey = orderedRoles.find((role) => !usedKeys.has(role.role))?.role ?? ""
    setFallbackChains((current) => [
      ...current,
      { id: nextFallbackChainId(), key: suggestedKey, selectors: [""] },
    ])
  }

  const moveFallback = (chainId: string, index: number, direction: -1 | 1) => {
    updateFallbackChain(chainId, (chain) => {
      const target = index + direction
      if (target < 0 || target >= chain.selectors.length) return chain
      const selectors = [...chain.selectors]
      ;[selectors[index], selectors[target]] = [selectors[target], selectors[index]]
      return { ...chain, selectors }
    })
    setOpenRole(null)
  }

  const chooseExecutable = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t(language, "executableLabel"),
      })
      if (typeof selected === "string") {
        setExecutable(selected)
      }
    } catch (error) {
      onError(errorMessage(error, language))
    }
  }

  const chooseSessionRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t(language, "sessionRootLabel"),
      })
      if (typeof selected === "string") {
        setSessionRoot(selected)
      }
    } catch (error) {
      onError(errorMessage(error, language))
    }
  }

  const addProviderKey = () => {
    const key = newKeyName.trim()
    const value = newKeyValue.trim()
    if (!key || !value) {
      return
    }
    setProviderEnv((current) => ({ ...current, [key]: value }))
    setNewKeyValue("")
  }

  const setProviderProxyMode = (provider: string, enabled: boolean) => {
    setProxyProviders((current) => {
      if (!enabled) return current.filter((candidate) => candidate !== provider)
      return current.includes(provider) ? current : [...current, provider].sort()
    })
  }
  const hasChanges = useMemo(() => {
    const generalChanged =
      (executable.trim() || null) !== settings.ompExecutable ||
      (sessionRoot.trim() || null) !== settings.sessionRoot ||
      language !== settings.language ||
      appFontFamily !== settings.appFontFamily ||
      terminalFontFamily !== settings.terminalFontFamily ||
      Number(terminalFontSize) !== settings.terminalFontSize

    const initialProviderEnvKeys = settings.providerEnvKeys
    const currentProviderEnvKeys = Object.keys(providerEnv)
    const providerEnvChanged =
      currentProviderEnvKeys.length !== initialProviderEnvKeys.length ||
      currentProviderEnvKeys.some((key) => !initialProviderEnvKeys.includes(key)) ||
      Object.values(providerEnv).some((value) => value.trim() !== "")

    if (generalChanged || providerEnvChanged) return true
    if (!runtime.ompAvailable || !ompConfig) return false

    const rolesChanged = ompConfig.roles.some(
      (role) => (roleDrafts[role.role] ?? "") !== role.selector,
    )
    let fallbackChainsChanged = false
    try {
      fallbackChainsChanged = !fallbackChainsEqual(
        serializeFallbackChains(fallbackChains, language),
        ompConfig.fallbackChains,
      )
    } catch {
      fallbackChainsChanged = true
    }

    return (
      rolesChanged ||
      advisorEnabled !== ompConfig.advisorEnabled ||
      autoResume !== ompConfig.autoResume ||
      thinkingLevel !== (ompConfig.defaultThinkingLevel ?? "medium") ||
      modelFallbackEnabled !== ompConfig.modelFallbackEnabled ||
      [...proxyProviders].sort().join("\u0000") !==
        [...ompConfig.proxyProviders].sort().join("\u0000") ||
      fallbackChainsChanged
    )
  }, [
    advisorEnabled,
    appFontFamily,
    autoResume,
    executable,
    fallbackChains,
    language,
    modelFallbackEnabled,
    ompConfig,
    providerEnv,
    proxyProviders,
    roleDrafts,
    runtime.ompAvailable,
    sessionRoot,
    settings,
    terminalFontFamily,
    terminalFontSize,
    thinkingLevel,
  ])

  const save = async () => {
    setSaving(true)
    try {
      const includeOmpConfig = runtime.ompAvailable && ompConfig !== null
      const fallbackConfig = includeOmpConfig
        ? serializeFallbackChains(fallbackChains, language)
        : null
      const result = await saveSettingsBundle({
        update: {
          ompExecutable: executable.trim() || null,
          sessionRoot: sessionRoot.trim() || null,
          language,
          appFontFamily,
          terminalFontFamily,
          terminalFontSize: Number(terminalFontSize),
          providerEnv,
        },
        ompConfig: includeOmpConfig
          ? {
              roles: roleDrafts,
              advisorEnabled,
              autoResume,
              defaultThinkingLevel: thinkingLevel,
              modelFallbackEnabled,
              fallbackChains: fallbackConfig,
              proxyProviders,
            }
          : null,
      })
      if (result.ompConfig) {
        const savedRoleDrafts: Record<string, string> = {}
        for (const role of result.ompConfig.roles) savedRoleDrafts[role.role] = role.selector
        setOmpConfig(result.ompConfig)
        setRoleDrafts(savedRoleDrafts)
        setAdvisorEnabled(result.ompConfig.advisorEnabled)
        setAutoResume(result.ompConfig.autoResume)
        setThinkingLevel(result.ompConfig.defaultThinkingLevel ?? "medium")
        setModelFallbackEnabled(result.ompConfig.modelFallbackEnabled)
        setFallbackChains(fallbackDraftsFromSnapshot(result.ompConfig.fallbackChains))
        setProxyProviders(result.ompConfig.proxyProviders)
        onConfigSaved?.(result.ompConfig)
      }
      setProviderEnv(
        Object.fromEntries(result.bootstrap.settings.providerEnvKeys.map((key) => [key, ""])),
      )
      onSaved(result.bootstrap)
    } catch (error) {
      onError(errorMessage(error, language))
    } finally {
      setSaving(false)
    }
  }

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
              {runtime.ompAvailable ? t(language, "ompConnected") : t(language, "ompMissing")}
            </strong>
            <span>{runtime.ompVersion ?? t(language, "ompPathHelp")}</span>
          </div>
          {runtime.ompAvailable && (
            <button
              className="button secondary"
              onClick={() => void refreshConfig(true)}
              disabled={loadingConfig || refreshCooldownSeconds > 0}
              type="button"
            >
              {loadingConfig ? (
                <>
                  <span aria-hidden="true" className="mini-loader" />
                  {t(language, "refreshingModels")}
                </>
              ) : refreshCooldownSeconds > 0 ? (
                `${t(language, "refreshModels")} · ${refreshCooldownSeconds}s`
              ) : (
                t(language, "refreshModels")
              )}
            </button>
          )}
        </div>

        {ompConfig && ompConfig.warnings.length > 0 && (
          <div className="settings-secret-warning" role="status">
            <Icon name="alert" size={16} />
            <span>
              <strong>{t(language, "configWarningsTitle")}</strong>
              {ompConfig.warnings.map((warning) => (
                <small key={`${warning.source}:${warning.code}`}>
                  {warning.source}: {warning.message}
                </small>
              ))}
            </span>
          </div>
        )}

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
              <small>{t(language, loadingSlow ? "loadingSlowBody" : "loadingBannerBody")}</small>
            </span>
            <span aria-hidden="true" className="settings-loading-progress">
              <span />
            </span>
          </div>
        )}

        <div className="settings-body">
          <nav
            aria-label={t(language, "settingsCategories")}
            aria-orientation="vertical"
            className="settings-nav"
            role="tablist"
          >
            <button
              aria-controls="settings-panel-general"
              aria-selected={activeSection === "general"}
              className={activeSection === "general" ? "is-active" : ""}
              id="settings-tab-general"
              onClick={() => {
                setActiveSection("general")
                setOpenRole(null)
              }}
              role="tab"
              type="button"
            >
              <Icon name="settings" size={15} />
              <span>{t(language, "settingsGeneralTab")}</span>
            </button>
            <button
              aria-controls="settings-panel-behavior"
              aria-selected={activeSection === "behavior"}
              className={activeSection === "behavior" ? "is-active" : ""}
              id="settings-tab-behavior"
              onClick={() => {
                setActiveSection("behavior")
                setOpenRole(null)
              }}
              role="tab"
              type="button"
            >
              <Icon name="command" size={15} />
              <span>{t(language, "settingsBehaviorTab")}</span>
            </button>
            <button
              aria-controls="settings-panel-models"
              aria-selected={activeSection === "models"}
              className={activeSection === "models" ? "is-active" : ""}
              id="settings-tab-models"
              onClick={() => {
                setActiveSection("models")
                setOpenRole(null)
              }}
              role="tab"
              type="button"
            >
              <Icon name="spark" size={15} />
              <span>{t(language, "settingsModelsTab")}</span>
            </button>
            <button
              aria-controls="settings-panel-providers"
              aria-selected={activeSection === "providers"}
              className={activeSection === "providers" ? "is-active" : ""}
              id="settings-tab-providers"
              onClick={() => {
                setActiveSection("providers")
                setOpenRole(null)
              }}
              role="tab"
              type="button"
            >
              <Icon name="terminal" size={15} />
              <span>{t(language, "settingsProvidersTab")}</span>
            </button>
          </nav>

          <div
            aria-labelledby={`settings-tab-${activeSection}`}
            className="settings-scroll"
            id={`settings-panel-${activeSection}`}
            role="tabpanel"
            tabIndex={0}
          >
            <div className="settings-fields">
              {activeSection === "general" && (
                <>
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

                    <label className="field-label" htmlFor="app-font-family">
                      {t(language, "appFontFamily")}
                    </label>
                    <input
                      id="app-font-family"
                      onChange={(event) => setAppFontFamily(event.target.value)}
                      spellCheck={false}
                      value={appFontFamily}
                    />
                    <p className="field-help">{t(language, "appFontFamilyHelp")}</p>
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
                </>
              )}

              {activeSection === "behavior" && (
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

                  <label className="field-label" htmlFor="terminal-font-family">
                    {t(language, "terminalFontFamily")}
                  </label>
                  <input
                    id="terminal-font-family"
                    onChange={(event) => setTerminalFontFamily(event.target.value)}
                    spellCheck={false}
                    value={terminalFontFamily}
                  />
                  <p className="field-help">{t(language, "terminalFontFamilyHelp")}</p>

                  <label className="field-label" htmlFor="terminal-font-size">
                    {t(language, "terminalFontSize")}
                  </label>
                  <div className="path-field select-field">
                    <select
                      id="terminal-font-size"
                      onChange={(event) => setTerminalFontSize(event.target.value)}
                      value={terminalFontSize}
                    >
                      {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((size) => (
                        <option key={size} value={size}>
                          {size}px
                        </option>
                      ))}
                    </select>
                    <Icon className="select-chevron" name="chevron" size={14} />
                  </div>
                  <p className="field-help">{t(language, "terminalFontSizeHelp")}</p>
                </section>
              )}

              {activeSection === "models" && (
                <>
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
                        <button
                          className="button secondary"
                          onClick={() => void refreshConfig()}
                          type="button"
                        >
                          {t(language, "retryModels")}
                        </button>
                      </div>
                    )}

                    {ompConfig &&
                      orderedRoles.map((role) => {
                        const draft = roleDrafts[role.role] ?? role.selector
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
                            <p className="role-description">
                              {roleDescription(language, role.role)}
                            </p>
                            <ModelPicker
                              language={language}
                              models={ompConfig.models}
                              onChange={(selector) =>
                                setRoleDrafts((current) => ({
                                  ...current,
                                  [role.role]: selector,
                                }))
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
                        )
                      })}
                  </section>

                  {ompConfig && (
                    <section className="settings-section settings-fallbacks-section">
                      <div className="settings-section-heading">
                        <div>
                          <span className="eyebrow">{t(language, "fallbackChains")}</span>
                          <p>{t(language, "fallbackChainsHelp")}</p>
                        </div>
                        <button
                          className="button secondary"
                          onClick={addFallbackChain}
                          type="button"
                        >
                          <Icon name="plus" size={13} />
                          {t(language, "addFallbackChain")}
                        </button>
                      </div>

                      <div className="settings-options">
                        <label className="toggle-row">
                          <input
                            checked={modelFallbackEnabled}
                            onChange={(event) => setModelFallbackEnabled(event.target.checked)}
                            type="checkbox"
                          />
                          <span>
                            <strong>{t(language, "fallbackModelToggle")}</strong>
                            <small>{t(language, "fallbackModelToggleHelp")}</small>
                          </span>
                        </label>
                      </div>

                      {fallbackChains.length === 0 && (
                        <div className="settings-state">
                          <Icon name="history" size={16} />
                          <span>{t(language, "noFallbackChains")}</span>
                        </div>
                      )}

                      <div className="fallback-chain-list">
                        {fallbackChains.map((chain) => (
                          <article className="fallback-chain" key={chain.id}>
                            <div className="fallback-chain-head">
                              <label className="fallback-chain-key">
                                <span>{t(language, "fallbackChainKey")}</span>
                                <input
                                  onChange={(event) =>
                                    updateFallbackChain(chain.id, (current) => ({
                                      ...current,
                                      key: event.target.value,
                                    }))
                                  }
                                  placeholder={t(language, "fallbackChainKeyPlaceholder")}
                                  spellCheck={false}
                                  value={chain.key}
                                />
                              </label>
                              <button
                                aria-label={t(language, "removeFallbackChain")}
                                className="icon-button fallback-chain-remove"
                                onClick={() =>
                                  setFallbackChains((current) =>
                                    current.filter((item) => item.id !== chain.id),
                                  )
                                }
                                title={t(language, "removeFallbackChain")}
                                type="button"
                              >
                                <Icon name="trash" size={14} />
                              </button>
                            </div>
                            <p className="fallback-chain-help">
                              {t(language, "fallbackChainKeyHelp")}
                            </p>

                            <div className="fallback-chain-label">
                              <strong>{t(language, "fallbackModels")}</strong>
                              <small>{t(language, "fallbackModelsHelp")}</small>
                            </div>
                            <div className="fallback-entry-list">
                              {chain.selectors.map((selector, index) => {
                                const pickerId = `fallback-${chain.id}-${index}`
                                return (
                                  <div className="fallback-entry" key={pickerId}>
                                    <span className="fallback-entry-index">{index + 1}</span>
                                    <ModelPicker
                                      language={language}
                                      models={ompConfig.models}
                                      onChange={(nextSelector) =>
                                        updateFallbackChain(chain.id, (current) => {
                                          const selectors = [...current.selectors]
                                          selectors[index] = nextSelector
                                          return { ...current, selectors }
                                        })
                                      }
                                      onOpenChange={(open) => setOpenRole(open ? pickerId : null)}
                                      open={openRole === pickerId}
                                      role={pickerId}
                                      value={selector}
                                    />
                                    <div className="fallback-entry-actions">
                                      <button
                                        aria-label={t(language, "moveFallbackUp")}
                                        className="icon-button"
                                        disabled={index === 0}
                                        onClick={() => moveFallback(chain.id, index, -1)}
                                        title={t(language, "moveFallbackUp")}
                                        type="button"
                                      >
                                        <Icon
                                          className="fallback-arrow is-up"
                                          name="arrow"
                                          size={13}
                                        />
                                      </button>
                                      <button
                                        aria-label={t(language, "moveFallbackDown")}
                                        className="icon-button"
                                        disabled={index === chain.selectors.length - 1}
                                        onClick={() => moveFallback(chain.id, index, 1)}
                                        title={t(language, "moveFallbackDown")}
                                        type="button"
                                      >
                                        <Icon
                                          className="fallback-arrow is-down"
                                          name="arrow"
                                          size={13}
                                        />
                                      </button>
                                      <button
                                        aria-label={t(language, "removeFallbackModel")}
                                        className="icon-button"
                                        disabled={chain.selectors.length === 1}
                                        onClick={() =>
                                          updateFallbackChain(chain.id, (current) => ({
                                            ...current,
                                            selectors: current.selectors.filter(
                                              (_, selectorIndex) => selectorIndex !== index,
                                            ),
                                          }))
                                        }
                                        title={t(language, "removeFallbackModel")}
                                        type="button"
                                      >
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                            <button
                              className="button secondary fallback-add-model"
                              onClick={() =>
                                updateFallbackChain(chain.id, (current) => ({
                                  ...current,
                                  selectors: [...current.selectors, ""],
                                }))
                              }
                              type="button"
                            >
                              <Icon name="plus" size={12} />
                              {t(language, "addFallbackModel")}
                            </button>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {activeSection === "providers" && (
                <>
                  {settings.secretStorageWarning && (
                    <div className="settings-secret-warning" role="status">
                      <Icon name="alert" size={16} />
                      <span>
                        <strong>{t(language, "secretStorageWarningTitle")}</strong>
                        <small>
                          {t(
                            language,
                            settings.secretStorageWarning === "fallback_file"
                              ? "secretStorageFallbackBody"
                              : "secretStorageUnavailableBody",
                          )}
                        </small>
                      </span>
                    </div>
                  )}
                  <section className="settings-section settings-accounts-section">
                    <div className="settings-section-heading">
                      <div>
                        <span className="eyebrow">{t(language, "connectedAccounts")}</span>
                        <p>{t(language, "connectedAccountsHelp")}</p>
                      </div>
                      {ompConfig && (
                        <span className="settings-count">
                          {accounts.length} {t(language, "accountsCount")}
                        </span>
                      )}
                    </div>
                    {ompConfig && (
                      <div
                        className={`provider-account-freshness${usageIsStale ? " is-stale" : ""}`}
                      >
                        <span>
                          {ompConfig.usageObservedAt === null
                            ? t(language, "accountUsageUnknown")
                            : t(language, usageIsStale ? "accountUsageStale" : "accountUsageFresh")}
                        </span>
                        {ompConfig.usageObservedAt !== null && (
                          <time dateTime={new Date(ompConfig.usageObservedAt).toISOString()}>
                            {formatAccountTimestamp(language, ompConfig.usageObservedAt)}
                          </time>
                        )}
                      </div>
                    )}
                    {loadingConfig && !ompConfig && (
                      <div aria-hidden="true" className="settings-role-skeletons is-compact">
                        {Array.from({ length: 2 }, (_, index) => (
                          <span className="settings-role-skeleton" key={index}>
                            <i />
                            <b />
                            <em />
                          </span>
                        ))}
                      </div>
                    )}
                    {ompConfig && accounts.length === 0 && (
                      <div className="settings-state">
                        <Icon name="terminal" size={16} />
                        <span>{t(language, "noConnectedAccounts")}</span>
                      </div>
                    )}
                    {ompConfig && accounts.length > 0 && (
                      <div className="provider-account-groups">
                        {accountGroups.map((group) => {
                          const configured = group.accounts.filter(
                            (account) => account.configured,
                          ).length
                          const reporting = group.accounts.filter(
                            (account) => account.reporting,
                          ).length
                          const routingKnown = group.accounts.filter(
                            (account) => account.routingEvidence !== "unknown",
                          ).length
                          const routable = group.accounts.filter(
                            (account) =>
                              account.routingEvidence !== "unknown" && account.routingEligible,
                          ).length
                          return (
                            <section className="provider-account-group" key={group.provider}>
                              <header className="provider-account-group-header">
                                <strong>{group.provider}</strong>
                                <span>
                                  {configured}/{group.accounts.length}{" "}
                                  {t(language, "accountsConfigured")} · {reporting}/
                                  {group.accounts.length} {t(language, "accountsReporting")} ·{" "}
                                  {routable}/{routingKnown} {t(language, "accountsRoutable")}
                                </span>
                              </header>
                              <div className="provider-account-list">
                                {group.accounts.map((account) => (
                                  <details
                                    className={`provider-account is-${account.status}`}
                                    data-testid={`provider-account-${account.id}`}
                                    key={account.id}
                                  >
                                    <summary className="provider-account-header">
                                      <div>
                                        <strong>{account.label}</strong>
                                        <span>
                                          {accountCredentialTypeLabel(
                                            language,
                                            account.credentialType,
                                          )}
                                        </span>
                                      </div>
                                      <span className={`credential-status is-${account.status}`}>
                                        {accountStatusLabel(language, account.status)}
                                      </span>
                                    </summary>
                                    <div className="provider-account-health">
                                      <span>
                                        {t(
                                          language,
                                          account.reporting
                                            ? "accountReportingYes"
                                            : "accountReportingNo",
                                        )}
                                      </span>
                                      <span
                                        className={
                                          account.routingEligible ? "is-eligible" : "is-ineligible"
                                        }
                                      >
                                        {accountRoutingLabel(language, account)}
                                      </span>
                                    </div>
                                    {account.statusReason && (
                                      <small className="provider-account-status-reason">
                                        {accountReasonLabel(language, account.statusReason)}
                                      </small>
                                    )}
                                    {account.fetchedAt !== null && (
                                      <small className="provider-account-fetched-at">
                                        {t(language, "accountObservedAt")}:{" "}
                                        {formatAccountTimestamp(language, account.fetchedAt)}
                                      </small>
                                    )}
                                    {account.routes.length > 0 && (
                                      <div className="provider-account-routes">
                                        {account.routes.map((route) => (
                                          <span
                                            className={`provider-account-route is-${route.status}`}
                                            key={route.id}
                                          >
                                            {route.label}:{" "}
                                            {accountRouteStatusLabel(language, route.status)}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    {account.limits.length > 0 ? (
                                      <div className="provider-account-limits">
                                        {account.limits.map((limit) => {
                                          const usedPercent = limit.usedPercent
                                          return (
                                            <div className="provider-account-limit" key={limit.id}>
                                              <div>
                                                <span>
                                                  {limit.label}
                                                  {limit.windowLabel
                                                    ? ` · ${limit.windowLabel}`
                                                    : ""}
                                                </span>
                                                <strong>
                                                  {usedPercent === null
                                                    ? "—"
                                                    : `${formatAccountPercent(language, usedPercent)}% · ${formatAccountPercent(language, 100 - usedPercent)}% ${t(language, "accountRemaining")}`}
                                                </strong>
                                              </div>
                                              <span
                                                aria-label={
                                                  usedPercent === null
                                                    ? undefined
                                                    : `${formatAccountPercent(language, usedPercent)}%`
                                                }
                                                aria-valuemax={
                                                  usedPercent === null ? undefined : 100
                                                }
                                                aria-valuemin={usedPercent === null ? undefined : 0}
                                                aria-valuenow={usedPercent ?? undefined}
                                                className={`provider-account-meter is-${limit.status}`}
                                                role={usedPercent === null ? undefined : "meter"}
                                              >
                                                <i
                                                  style={{
                                                    width: `${Math.min(100, Math.max(0, limit.usedPercent ?? 0))}%`,
                                                  }}
                                                />
                                              </span>
                                              <small>
                                                {limit.resetsAt === null
                                                  ? t(language, "accountResetUnknown")
                                                  : `${t(language, "accountResetsAt")}: ${formatAccountTimestamp(language, limit.resetsAt)} · ${t(language, "accountResetIn")} ${formatAccountCountdown(language, limit.resetsAt, clockNow)}`}
                                              </small>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    ) : (
                                      <small className="provider-account-empty">
                                        {t(language, "accountNoLimits")}
                                      </small>
                                    )}
                                  </details>
                                ))}
                              </div>
                            </section>
                          )
                        })}
                      </div>
                    )}
                  </section>

                  <section className="settings-section">
                    <div className="settings-section-heading">
                      <div>
                        <span className="eyebrow">{t(language, "connectedProviders")}</span>
                        <p>{t(language, "connectedProvidersHelp")}</p>
                      </div>
                    </div>
                    {loadingConfig && !ompConfig && (
                      <div aria-hidden="true" className="settings-role-skeletons is-compact">
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
                        <button
                          className="button secondary"
                          onClick={() => void refreshConfig()}
                          type="button"
                        >
                          {t(language, "retryModels")}
                        </button>
                      </div>
                    )}
                    {ompConfig && credentials.length === 0 && (
                      <div className="settings-state">
                        <Icon name="terminal" size={16} />
                        <span>{t(language, "noConnectedProviders")}</span>
                      </div>
                    )}
                    {ompConfig && credentials.length > 0 && (
                      <div className="provider-credential-list">
                        {credentials.map((credential) => (
                          <article className="provider-credential" key={credential.provider}>
                            <div className="provider-credential-main">
                              <strong>{credential.provider}</strong>
                              {credential.keyName && <code>{credential.keyName}</code>}
                            </div>
                            <span className="provider-credential-source">
                              {credentialSourceLabel(language, credential.source)}
                            </span>
                            <span className={`credential-status is-${credential.status}`}>
                              {credentialStatusLabel(language, credential)}
                            </span>
                            <small>
                              {t(language, "credentialModels").replace(
                                "{count}",
                                String(credential.modelCount),
                              )}
                            </small>
                            <label className="toggle-row provider-proxy-toggle">
                              <input
                                checked={proxyProviders.includes(credential.provider)}
                                onChange={(event) =>
                                  setProviderProxyMode(credential.provider, event.target.checked)
                                }
                                type="checkbox"
                              />
                              <span>
                                <strong>{t(language, "providerProxyMode")}</strong>
                                <small>{t(language, "providerProxyModeHelp")}</small>
                              </span>
                            </label>
                          </article>
                        ))}
                      </div>
                    )}
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
                      .map(([key]) => (
                        <div className="provider-key-row" key={key}>
                          <code>{key}</code>
                          <span>••••••••</span>
                          <button
                            className="button secondary"
                            onClick={() =>
                              setProviderEnv((current) => {
                                const next = { ...current }
                                delete next[key]
                                return next
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
                </>
              )}
            </div>
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
            disabled={saving || !hasChanges}
            onClick={() => void save()}
            type="button"
          >
            {saving ? t(language, "saving") : t(language, "save")}
          </button>
        </footer>
      </section>
    </div>
  )
}

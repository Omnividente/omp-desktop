import type { ChangeEvent } from "react"
import { Icon } from "./Icon"
import {
  matchesSelector,
  normalizeThinkingLevel,
  splitSelector,
  thinkingOptionsForModel,
} from "./ModelPicker"
import { t, thinkingLevelLabel, type Lang } from "./i18n"
import type { RuntimeHealthStatus } from "./runtimeIncidents"
import type { OmpConfigSnapshot, TerminalTab } from "./types"

interface SessionControlsProps {
  tab: TerminalTab
  ompConfig: OmpConfigSnapshot | null
  lang: Lang
  runtimeStatus: RuntimeHealthStatus
  onSwitch: (tabId: string, model: string, thinking: string | null) => void
  onTogglePrimaryProviderPin: (tabId: string, pinned: boolean) => void
}

export function SessionControls({
  tab,
  ompConfig,
  lang,
  runtimeStatus,
  onSwitch,
  onTogglePrimaryProviderPin,
}: SessionControlsProps) {
  if (!ompConfig || tab.status !== "running" || tab.kind !== "agent") return null

  const defaultSelector = ompConfig.roles.find((role) => role.role === "default")?.selector ?? ""
  const configured = splitSelector(tab.currentModel ?? defaultSelector)
  const selectedModel = ompConfig.models.find((model) => matchesSelector(model, configured.base))
  const baseModel = selectedModel ? splitSelector(selectedModel.selector).base : configured.base
  const thinkingOptions = thinkingOptionsForModel(selectedModel)
  const preferredThinking =
    tab.currentThinkingConfigured ??
    tab.currentThinking ??
    configured.thinking ??
    ompConfig.defaultThinkingLevel
  const currentThinking = normalizeThinkingLevel(
    preferredThinking,
    thinkingOptions,
    ompConfig.defaultThinkingLevel,
  )

  const modelsByProvider = ompConfig.models.reduce<Record<string, typeof ompConfig.models>>(
    (providers, model) => {
      const provider = model.provider || "unknown"
      ;(providers[provider] ??= []).push(model)
      return providers
    },
    {},
  )

  const switchSelection = (model: string, thinking: string | null) => {
    if (!model || tab.switching) return
    onSwitch(tab.id, model, thinking)
  }

  const handleModelChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextBase = event.target.value
    if (nextBase === baseModel) return
    const nextModel = ompConfig.models.find((model) => matchesSelector(model, nextBase))
    if (!nextModel?.available) return
    const nextOptions = thinkingOptionsForModel(nextModel)
    const nextThinking = normalizeThinkingLevel(
      currentThinking,
      nextOptions,
      ompConfig.defaultThinkingLevel,
    )
    switchSelection(splitSelector(nextModel.selector).base, nextThinking)
  }

  const handleThinkingChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextThinking = event.target.value
    if (nextThinking === currentThinking || !thinkingOptions.includes(nextThinking)) {
      return
    }
    switchSelection(baseModel, nextThinking)
  }

  const providerPinAction = t(
    lang,
    tab.primaryProviderPinned ? "unpinPrimaryProvider" : "pinPrimaryProvider",
  )
  const providerPinState = t(
    lang,
    tab.primaryProviderPinned ? "primaryProviderPinOn" : "primaryProviderPinOff",
  )

  return (
    <div aria-busy={tab.switching} className="session-controls">
      <select
        aria-label={t(lang, "sessionModel")}
        className="session-model-select"
        disabled={tab.switching}
        onChange={handleModelChange}
        title={t(lang, "sessionModel")}
        value={baseModel}
      >
        {!selectedModel && baseModel && <option value={baseModel}>{baseModel}</option>}
        {Object.entries(modelsByProvider).map(([provider, models]) => (
          <optgroup label={provider} key={provider}>
            {models.map((model) => {
              const selector = splitSelector(model.selector).base
              return (
                <option disabled={!model.available} key={model.selector} value={selector}>
                  {model.name}
                </option>
              )
            })}
          </optgroup>
        ))}
      </select>
      <select
        aria-label={t(lang, "sessionThinking")}
        className="session-thinking-select"
        disabled={tab.switching || thinkingOptions.length === 0}
        onChange={handleThinkingChange}
        title={t(lang, "sessionThinking")}
        value={currentThinking ?? ""}
      >
        {thinkingOptions.length === 0 ? (
          <option value="">{t(lang, "thinkingUnavailable")}</option>
        ) : (
          thinkingOptions.map((level) => (
            <option key={level} value={level}>
              {thinkingLevelLabel(lang, level)}
            </option>
          ))
        )}
      </select>
      <button
        aria-busy={tab.primaryProviderPinPending}
        aria-checked={tab.primaryProviderPinned}
        aria-label={`${t(lang, "primaryProvider")}: ${providerPinState}. ${providerPinAction}`}
        className={`primary-provider-pin${tab.primaryProviderPinned ? " is-active" : ""}${tab.primaryProviderPinPending ? " is-pending" : ""}`}
        disabled={tab.switching || tab.primaryProviderPinPending}
        onClick={() => onTogglePrimaryProviderPin(tab.id, !tab.primaryProviderPinned)}
        role="switch"
        title={providerPinAction}
        type="button"
      >
        <Icon name="pin" size={11} />
        <span className="primary-provider-pin-label">{t(lang, "primaryProvider")}</span>
        <span aria-hidden="true" className="primary-provider-toggle-track" />
        <span className="primary-provider-pin-state">{providerPinState}</span>
      </button>
      {runtimeStatus === "fallback" && !tab.switching && (
        <span aria-live="polite" className="session-fallback">
          {t(lang, "fallbackActive")}
        </span>
      )}
      {tab.switching && (
        <span aria-live="polite" className="session-switching">
          {t(lang, "switchingSession")}
        </span>
      )}
    </div>
  )
}

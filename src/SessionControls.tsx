import type { ChangeEvent } from "react"
import { matchesSelector, splitSelector } from "./ModelPicker"
import { t, thinkingLevelLabel, type Lang } from "./i18n"
import type { RuntimeHealthStatus } from "./runtimeIncidents"
import type { OmpConfigSnapshot, TerminalTab } from "./types"

interface SessionControlsProps {
  tab: TerminalTab
  ompConfig: OmpConfigSnapshot | null
  lang: Lang
  runtimeStatus: RuntimeHealthStatus
  onSwitch: (tabId: string, model: string, thinking: string | null) => void
}

export function SessionControls({
  tab,
  ompConfig,
  lang,
  runtimeStatus,
  onSwitch,
}: SessionControlsProps) {
  if (!ompConfig || tab.status !== "running" || tab.kind !== "agent") return null

  const defaultSelector = ompConfig.roles.find((role) => role.role === "default")?.selector ?? ""
  const configured = splitSelector(tab.currentModel ?? defaultSelector)
  const selectedModel = ompConfig.models.find((model) => matchesSelector(model, configured.base))
  const baseModel = selectedModel ? splitSelector(selectedModel.selector).base : configured.base
  const supportedThinking = selectedModel?.thinking ?? []
  const thinkingOptions =
    supportedThinking.length === 0
      ? []
      : ["off", "auto", ...supportedThinking.filter((level) => level !== "off" && level !== "auto")]
  const preferredThinking =
    tab.currentThinkingConfigured ??
    tab.currentThinking ??
    configured.thinking ??
    ompConfig.defaultThinkingLevel
  const currentThinking =
    preferredThinking && thinkingOptions.includes(preferredThinking)
      ? preferredThinking
      : (thinkingOptions[0] ?? null)

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
    const defaultThinking = ompConfig.defaultThinkingLevel
    const nextOptions =
      nextModel.thinking.length === 0
        ? []
        : [
            "off",
            "auto",
            ...nextModel.thinking.filter((level) => level !== "off" && level !== "auto"),
          ]
    const nextThinking =
      currentThinking && nextOptions.includes(currentThinking)
        ? currentThinking
        : defaultThinking && nextOptions.includes(defaultThinking)
          ? defaultThinking
          : (nextOptions[0] ?? null)
    switchSelection(splitSelector(nextModel.selector).base, nextThinking)
  }

  const handleThinkingChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextThinking = event.target.value
    if (nextThinking === currentThinking || !thinkingOptions.includes(nextThinking)) {
      return
    }
    switchSelection(baseModel, nextThinking)
  }

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

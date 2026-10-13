import { type ChangeEvent, useLayoutEffect, useRef } from "react"
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
  installingDesktopUpdate: boolean
  onDiscardSwitchRecovery: (tabId: string) => void
  onSendSwitchRecovery: (tabId: string) => void
  onSwitch: (tabId: string, model: string, thinking: string | null) => void
  onTogglePrimaryProviderPin: (tabId: string, pinned: boolean) => void
}

export function SessionControls({
  tab,
  ompConfig,
  lang,
  onDiscardSwitchRecovery,
  onSendSwitchRecovery,
  runtimeStatus,
  installingDesktopUpdate,
  onSwitch,
  onTogglePrimaryProviderPin,
}: SessionControlsProps) {
  const controlsRef = useRef<HTMLDivElement>(null)
  const providerPinRef = useRef<HTMLButtonElement>(null)
  const pinFocusRequestedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (pinFocusRequestedRef.current === null) return
    if (pinFocusRequestedRef.current !== tab.sessionPath) {
      pinFocusRequestedRef.current = null
      return
    }
    const controls = controlsRef.current
    const pin = providerPinRef.current
    if (!controls || !pin) {
      pinFocusRequestedRef.current = null
      return
    }
    const active = document.activeElement
    if (tab.primaryProviderPinPending) {
      if (active === pin || active === document.body) controls.focus({ preventScroll: true })
      else if (active !== controls) pinFocusRequestedRef.current = null
    } else {
      pinFocusRequestedRef.current = null
      if (active === controls) pin.focus({ preventScroll: true })
    }
  })
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

  const recoveryPending = tab.switchRecovery !== null
  const switchSelection = (model: string, thinking: string | null) => {
    if (!model || tab.switching || tab.primaryProviderPinPending || recoveryPending) return
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
  const providerPinTitle = tab.sessionPath
    ? tab.activity === "thinking"
      ? t(lang, "primaryProviderPinBusy")
      : providerPinAction
    : t(lang, "primaryProviderPinNotReady")

  const showFallback =
    runtimeStatus === "fallback" && !tab.switching && !tab.primaryProviderPinPending
  const statusMessage = tab.primaryProviderPinPending
    ? t(lang, "restartingSession")
    : tab.switching
      ? t(lang, "switchingSession")
      : showFallback
        ? t(lang, "fallbackActive")
        : ""

  return (
    <>
      <div
        aria-busy={tab.switching || tab.primaryProviderPinPending || recoveryPending}
        className="session-controls"
        aria-label={tab.label}
        ref={controlsRef}
        role="group"
        tabIndex={-1}
      >
        <select
          aria-label={t(lang, "sessionModel")}
          className="session-model-select"
          disabled={tab.switching || tab.primaryProviderPinPending || recoveryPending}
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
          disabled={
            tab.switching ||
            tab.primaryProviderPinPending ||
            recoveryPending ||
            thinkingOptions.length === 0
          }
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
          aria-label={`${t(lang, "primaryProvider")}: ${providerPinState}. ${providerPinTitle}`}
          className={`primary-provider-pin${tab.primaryProviderPinned ? " is-active" : ""}${tab.primaryProviderPinPending ? " is-pending" : ""}`}
          disabled={
            installingDesktopUpdate ||
            tab.sessionPath === null ||
            tab.activity === "thinking" ||
            tab.switching ||
            recoveryPending ||
            tab.primaryProviderPinPending
          }
          onClick={(event) => {
            pinFocusRequestedRef.current =
              document.activeElement === event.currentTarget ? tab.sessionPath : null
            onTogglePrimaryProviderPin(tab.id, !tab.primaryProviderPinned)
          }}
          ref={providerPinRef}
          role="switch"
          title={providerPinTitle}
          type="button"
        >
          <Icon name="pin" size={11} />
          <span className="primary-provider-pin-label">{t(lang, "primaryProvider")}</span>
          <span aria-hidden="true" className="primary-provider-toggle-track" />
          <span className="primary-provider-pin-state">{providerPinState}</span>
        </button>
        {tab.switchRecovery && (
          <div
            aria-live={tab.switchRecovery.state === "sending" ? "polite" : "assertive"}
            className={`switch-input-recovery is-${tab.switchRecovery.state}`}
            role={tab.switchRecovery.state === "sending" ? "status" : "alert"}
          >
            <span className="switch-input-recovery-message">
              {t(
                lang,
                tab.switchRecovery.state === "failedSend"
                  ? "switchRecoveryFailedSend"
                  : tab.switchRecovery.state === "sending"
                    ? "switchRecoverySending"
                    : "switchRecoveryPending",
              ).replace("{count}", String(tab.switchRecovery.byteCount))}
            </span>
            <span className="switch-input-recovery-actions">
              <button
                disabled={tab.switchRecovery.state !== "pending"}
                onClick={() => onSendSwitchRecovery(tab.id)}
                type="button"
              >
                {t(lang, "switchRecoverySend")}
              </button>
              <button
                disabled={tab.switchRecovery.state === "sending"}
                onClick={() => onDiscardSwitchRecovery(tab.id)}
                type="button"
              >
                {t(lang, "switchRecoveryDiscard")}
              </button>
            </span>
          </div>
        )}
      </div>
      <span
        aria-live="polite"
        aria-atomic="true"
        className={
          showFallback ? "session-fallback" : statusMessage ? "session-switching" : "sr-only"
        }
        role="status"
      >
        {statusMessage}
      </span>
    </>
  )
}

import { type ChangeEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Icon } from "./Icon"
import { normalizeThinkingLevel, thinkingOptionsForModel } from "./ModelPicker"
import { t, thinkingLevelLabel, type Lang } from "./i18n"
import { sessionModelSelection } from "./sessionModelSelection"
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
  const [modelQuery, setModelQuery] = useState("")
  const [modelSearchOpen, setModelSearchOpen] = useState(false)
  const modelSearchId = useId()
  const modelControlRef = useRef<HTMLDivElement>(null)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelSearchButtonRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    setModelQuery("")
    setModelSearchOpen(false)
  }, [tab.id])
  useLayoutEffect(() => {
    if (modelSearchOpen) modelSearchRef.current?.focus({ preventScroll: true })
  }, [modelSearchOpen])
  useEffect(() => {
    if (!modelSearchOpen) return
    const dismissOutsideSearch = (event: PointerEvent) => {
      if (event.target instanceof Node && !modelControlRef.current?.contains(event.target)) {
        setModelQuery("")
        setModelSearchOpen(false)
      }
    }
    document.addEventListener("pointerdown", dismissOutsideSearch)
    return () => document.removeEventListener("pointerdown", dismissOutsideSearch)
  }, [modelSearchOpen])
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
  const chatModels = ompConfig.models.filter((model) => (model.kind ?? "chat") === "chat")
  const configured = sessionModelSelection(chatModels, tab.currentModel ?? defaultSelector)
  const selectedModel = configured.model
  const baseModel = configured.base
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

  const normalizedQuery = modelQuery.trim().toLocaleLowerCase()
  const matchingModels = normalizedQuery
    ? chatModels.filter((model) =>
        [model.name, model.provider, model.id, model.selector]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : chatModels
  const modelsByProvider = matchingModels.reduce<Record<string, typeof chatModels>>(
    (providers, model) => {
      const provider = model.provider || "unknown"
      ;(providers[provider] ??= []).push(model)
      return providers
    },
    Object.create(null),
  )

  const recoveryPending = tab.switchRecovery !== null
  const modelControlsDisabled = tab.switching || tab.primaryProviderPinPending || recoveryPending
  const closeModelSearch = () => {
    setModelQuery("")
    setModelSearchOpen(false)
  }
  const switchSelection = (model: string, thinking: string | null) => {
    if (!model || tab.switching || tab.primaryProviderPinPending || recoveryPending) return
    onSwitch(tab.id, model, thinking)
  }

  const handleModelChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextBase = event.target.value
    if (nextBase === baseModel) return
    // The select supplies an exact catalog value, never a bare-ID alias.
    const candidates = chatModels.filter((model) => model.selector === nextBase)
    if (candidates.length !== 1 || !candidates[0].available) return
    const nextModel = candidates[0]
    const nextOptions = thinkingOptionsForModel(nextModel)
    const nextThinking = normalizeThinkingLevel(
      currentThinking,
      nextOptions,
      ompConfig.defaultThinkingLevel,
    )
    switchSelection(nextModel.selector, nextThinking)
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
        <div
          className="session-model-control"
          onBlur={(event) => {
            const next = event.relatedTarget
            if (next instanceof Node && !event.currentTarget.contains(next)) closeModelSearch()
          }}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
              return
            if (event.key === "Escape" && modelSearchOpen) {
              event.preventDefault()
              event.stopPropagation()
              closeModelSearch()
              modelSearchButtonRef.current?.focus({ preventScroll: true })
            }
          }}
          ref={modelControlRef}
        >
          {modelSearchOpen && (
            <div className="session-model-search-panel" id={modelSearchId}>
              <input
                aria-label={t(lang, "searchModels")}
                className="session-model-search"
                disabled={modelControlsDisabled}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t(lang, "searchModelsPlaceholder")}
                ref={modelSearchRef}
                type="search"
                value={modelQuery}
              />
              {normalizedQuery && matchingModels.length === 0 && (
                <span className="session-model-search-empty" role="status">
                  {t(lang, "noModelsFound")}
                </span>
              )}
            </div>
          )}
          <div className="session-model-choice">
            <select
              aria-label={t(lang, "sessionModel")}
              className="session-model-select"
              disabled={modelControlsDisabled}
              onChange={handleModelChange}
              title={t(lang, "sessionModel")}
              value={baseModel}
            >
              {baseModel && (!selectedModel || !matchingModels.includes(selectedModel)) && (
                <option value={baseModel}>
                  {selectedModel ? `${selectedModel.name} (${baseModel})` : baseModel}
                </option>
              )}
              {matchingModels.length === 0 && normalizedQuery && (
                <option disabled value="">
                  {t(lang, "noModelsFound")}
                </option>
              )}
              {Object.entries(modelsByProvider).map(([provider, models]) => (
                <optgroup label={provider} key={provider}>
                  {models.map((model) => {
                    const selector = model.selector
                    return (
                      <option disabled={!model.available} key={model.selector} value={selector}>
                        {model.name}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
            <button
              aria-controls={modelSearchId}
              aria-expanded={modelSearchOpen}
              aria-label={t(lang, modelSearchOpen ? "closeModelSearch" : "searchModels")}
              className="session-model-search-toggle"
              disabled={modelControlsDisabled}
              onClick={() => {
                if (modelSearchOpen) closeModelSearch()
                else setModelSearchOpen(true)
              }}
              ref={modelSearchButtonRef}
              title={t(lang, modelSearchOpen ? "closeModelSearch" : "searchModels")}
              type="button"
            >
              <Icon name={modelSearchOpen ? "close" : "search"} size={13} />
            </button>
          </div>
        </div>
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

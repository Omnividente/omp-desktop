import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react"
import { Icon } from "./Icon"
import { statusLabel, t, thinkingLevelLabel, type Lang } from "./i18n"
import type { OmpModelInfo } from "./types"

interface ModelPickerProps {
  language: Lang
  models: OmpModelInfo[]
  onChange: (selector: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  role: string
  value: string
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/i
const THINKING_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

export function splitSelector(selector: string): { base: string; thinking: string | null } {
  const match = selector.match(THINKING_SUFFIX)
  if (!match || match.index === undefined) {
    return { base: selector, thinking: null }
  }
  return {
    base: selector.slice(0, match.index),
    thinking: match[1].toLowerCase(),
  }
}

export function thinkingLevelsForModel(model: OmpModelInfo | undefined): string[] {
  return model ? [...new Set(model.thinking)] : []
}

export function thinkingOptionsForModel(model: OmpModelInfo | undefined): string[] {
  const supported = thinkingLevelsForModel(model)
  return supported.length === 0
    ? []
    : ["off", "auto", ...supported.filter((level) => level !== "off" && level !== "auto")]
}

export function normalizeThinkingLevel(
  preferred: string | null | undefined,
  supported: string[],
  fallback?: string | null,
): string | null {
  if (supported.length === 0) return null
  const options = [...new Set(supported.map((level) => level.toLowerCase()))]
  for (const candidate of [preferred, fallback]) {
    const normalized = candidate?.toLowerCase()
    if (!normalized) continue
    if (options.includes(normalized)) return normalized
    const targetRank = THINKING_LEVEL_ORDER.indexOf(
      normalized as (typeof THINKING_LEVEL_ORDER)[number],
    )
    if (targetRank < 0) continue
    let nearest: { level: string; distance: number; rank: number } | null = null
    for (const level of options) {
      const rank = THINKING_LEVEL_ORDER.indexOf(level as (typeof THINKING_LEVEL_ORDER)[number])
      if (rank < 0) continue
      const distance = Math.abs(rank - targetRank)
      if (
        !nearest ||
        distance < nearest.distance ||
        (distance === nearest.distance && rank < nearest.rank)
      ) {
        nearest = { level, distance, rank }
      }
    }
    if (nearest) return nearest.level
  }
  return options.includes("auto") ? "auto" : options[0]
}

export function selectorWithThinking(selector: string, thinking: string | null): string {
  const base = splitSelector(selector).base
  return thinking ? `${base}:${thinking}` : base
}

function selectorForModel(model: OmpModelInfo, current: string): string {
  const { thinking } = splitSelector(current)
  if (thinking && thinkingOptionsForModel(model).includes(thinking)) {
    return `${model.selector}:${thinking}`
  }
  return model.selector
}

export function matchesSelector(model: OmpModelInfo, selector: string): boolean {
  const base = splitSelector(selector).base.toLowerCase()
  return (
    model.selector.toLowerCase() === base ||
    model.id.toLowerCase() === base ||
    `${model.provider}/${model.id}`.toLowerCase() === base
  )
}

interface ModelEntry {
  model: OmpModelInfo
  selector: string
  id: string
  providerId: string
  searchText: string
  sortKey: string
}

function matchesBase(entry: ModelEntry, base: string): boolean {
  return entry.selector === base || entry.id === base || entry.providerId === base
}

export function ModelPicker({
  language,
  models,
  onChange,
  onOpenChange,
  open,
  role,
  value,
}: ModelPickerProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const panelId = `model-picker-${role.replace(/[^a-z0-9_-]/gi, "-")}`
  const modelEntries = useMemo<ModelEntry[]>(
    () =>
      models.map((model) => ({
        model,
        selector: model.selector.toLowerCase(),
        id: model.id.toLowerCase(),
        providerId: `${model.provider}/${model.id}`.toLowerCase(),
        searchText: [model.name, model.provider, model.id, model.selector].join(" ").toLowerCase(),
        sortKey: `${model.provider}/${model.name}`,
      })),
    [models],
  )
  const configured = splitSelector(value)
  const selectedBase = configured.base.toLowerCase()
  const selectedModel = modelEntries.find((entry) => matchesBase(entry, selectedBase))?.model
  const selectedStatus = selectedModel?.status ?? (value ? "missing" : "unset")
  const configuredThinking = configured.thinking
  const thinkingLevels = thinkingOptionsForModel(selectedModel)

  const sortedEntries = useMemo(
    () =>
      [...modelEntries].sort((left, right) => {
        if (left.model.available !== right.model.available) {
          return left.model.available ? -1 : 1
        }
        return left.sortKey.localeCompare(right.sortKey)
      }),
    [modelEntries],
  )
  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized
      ? sortedEntries.filter((entry) => entry.searchText.includes(normalized))
      : sortedEntries
  }, [sortedEntries, query])

  const setOpen = (next: boolean) => {
    if (!next) {
      setQuery("")
      setActiveIndex(-1)
    }
    onOpenChange(next)
  }

  const closePicker = () => {
    const trigger = triggerRef.current
    if (
      panelRef.current?.contains(document.activeElement) &&
      trigger?.isConnected &&
      !trigger.disabled &&
      !trigger.closest("[hidden], [inert]")
    ) {
      trigger.focus({ preventScroll: true })
    }
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const selectedIndex = filteredEntries.findIndex((entry) => matchesBase(entry, selectedBase))
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : filteredEntries.length > 0 ? 0 : -1)
  }, [filteredEntries, open, query, selectedBase, value])

  const chooseActiveModel = () => {
    const entry = filteredEntries[activeIndex]
    if (!entry) return
    onChange(selectorForModel(entry.model, value))
    closePicker()
  }

  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (filteredEntries.length === 0) return
    let nextIndex: number | null = null
    if (event.key === "ArrowDown") {
      nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % filteredEntries.length
    } else if (event.key === "ArrowUp") {
      nextIndex = activeIndex <= 0 ? filteredEntries.length - 1 : activeIndex - 1
    } else if (event.key === "Home") {
      nextIndex = 0
    } else if (event.key === "End") {
      nextIndex = filteredEntries.length - 1
    } else if (event.key === "Enter" || event.key === " ") {
      chooseActiveModel()
      event.preventDefault()
      return
    }
    if (nextIndex !== null) {
      event.preventDefault()
      setActiveIndex(nextIndex)
      optionRefs.current[nextIndex]?.focus({ preventScroll: true })
    }
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) {
      setOpen(false)
    }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === "Escape" && open) {
      event.preventDefault()
      event.stopPropagation()
      closePicker()
    }
  }

  return (
    <div
      className={`model-picker${open ? " is-open" : ""}`}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="model-picker-trigger"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="model-picker-copy">
          <strong>
            {selectedModel?.name ??
              (value ? t(language, "customModel") : t(language, "statusUnset"))}
          </strong>
          <small>{value || t(language, "statusUnset")}</small>
        </span>
        <span className={`model-picker-status is-${selectedStatus}`}>
          {statusLabel(language, selectedStatus)}
        </span>
        <Icon className="model-picker-chevron" name="chevron" size={15} />
      </button>

      {thinkingLevels.length > 0 && (
        <label className="model-picker-thinking">
          <span>{t(language, "modelThinkingLevel")}</span>
          <span className="model-picker-thinking-control">
            <select
              aria-label={t(language, "modelThinkingLevel")}
              onChange={(event) =>
                onChange(selectorWithThinking(value, event.target.value || null))
              }
              value={configuredThinking ?? ""}
            >
              <option value="">{t(language, "modelThinkingDefault")}</option>
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {thinkingLevelLabel(language, level)}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={12} />
          </span>
        </label>
      )}

      {open && (
        <div className="model-picker-panel" id={panelId} ref={panelRef}>
          <label className="model-picker-search">
            <Icon name="search" size={14} />
            <input
              aria-label={t(language, "searchModels")}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === "Enter") {
                  if (filteredEntries[activeIndex]) {
                    event.preventDefault()
                    chooseActiveModel()
                  }
                  return
                }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
                if (filteredEntries.length === 0) return
                event.preventDefault()
                const nextIndex = event.key === "ArrowDown" ? 0 : filteredEntries.length - 1
                setActiveIndex(nextIndex)
                optionRefs.current[nextIndex]?.focus({ preventScroll: true })
              }}
              placeholder={t(language, "searchModelsPlaceholder")}
              spellCheck={false}
              value={query}
            />
          </label>

          <div
            aria-activedescendant={
              activeIndex >= 0 ? `${panelId}-option-${activeIndex}` : undefined
            }
            aria-label={t(language, "chooseModel")}
            className="model-picker-options"
            onKeyDown={handleListboxKeyDown}
            role="listbox"
            tabIndex={0}
          >
            {filteredEntries.map((entry, index) => {
              const { model } = entry
              const selected = matchesBase(entry, selectedBase)
              return (
                <button
                  aria-selected={selected}
                  className={`model-picker-option${selected ? " is-selected" : ""}`}
                  id={`${panelId}-option-${index}`}
                  key={model.selector}
                  onClick={() => {
                    onChange(selectorForModel(model, value))
                    closePicker()
                  }}
                  onFocus={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.selector}</small>
                  </span>
                  <span className={`model-picker-option-status is-${model.status}`}>
                    {statusLabel(language, model.status)}
                  </span>
                </button>
              )
            })}
            {filteredEntries.length === 0 && (
              <div className="model-picker-empty">{t(language, "noModelsFound")}</div>
            )}
          </div>

          <div className="model-picker-manual">
            <label htmlFor={`${panelId}-manual`}>{t(language, "manualSelector")}</label>
            <div>
              <input
                id={`${panelId}-manual`}
                onChange={(event) => onChange(event.target.value)}
                placeholder="provider/model-id[:thinking]"
                spellCheck={false}
                value={value}
              />
              <button className="button secondary" onClick={closePicker} type="button">
                {t(language, "done")}
              </button>
            </div>
            <p>{t(language, "manualSelectorHelp")}</p>
          </div>
        </div>
      )}
    </div>
  )
}

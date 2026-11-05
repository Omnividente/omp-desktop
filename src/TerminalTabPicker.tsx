import { useId, useLayoutEffect, useRef, useState } from "react"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { TerminalTab } from "./types"
import { useModalFocus } from "./useModalFocus"

interface TerminalTabPickerProps {
  tabs: TerminalTab[]
  activeTabId: string | null
  language: Lang
  onClose: () => void
  onSelect: (terminalId: string) => void
}

export function TerminalTabPicker({
  tabs,
  activeTabId,
  language,
  onClose,
  onSelect,
}: TerminalTabPickerProps) {
  const titleId = useId()
  const resultsId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const onKeyDown = useModalFocus(panelRef, onClose)
  useLayoutEffect(() => inputRef.current?.focus({ preventScroll: true }), [])

  const normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase(language)
  const results = tabs.filter((tab) =>
    [tab.label, tab.cwd].some((value) =>
      value.normalize("NFC").toLocaleLowerCase(language).includes(normalizedQuery),
    ),
  )

  return (
    <div
      className="settings-backdrop terminal-tab-picker-backdrop"
      onMouseDown={onClose}
      role="presentation"
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="settings-panel terminal-tab-picker"
        onKeyDown={(event) => {
          onKeyDown(event)
          // A local picker must not invoke the application's new/close-tab shortcuts.
          event.stopPropagation()
        }}
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="settings-header">
          <h2 id={titleId}>{t(language, "terminalTabPickerTitle")}</h2>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <input
          aria-controls={resultsId}
          aria-label={t(language, "terminalTabPickerSearch")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            // Enter is unambiguous only after the search has narrowed to one tab.
            if (
              event.key === "Enter" &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              results.length === 1
            ) {
              event.preventDefault()
              onSelect(results[0].id)
            }
          }}
          placeholder={t(language, "terminalTabPickerSearch")}
          ref={inputRef}
          type="search"
          value={query}
        />
        <p aria-live="polite" className="field-help">
          {t(language, "terminalTabPickerCount")
            .replace("{count}", String(results.length))
            .replace("{total}", String(tabs.length))}
        </p>
        <div className="terminal-tab-picker-results" id={resultsId}>
          {results.length === 0 && <p>{t(language, "terminalTabPickerEmpty")}</p>}
          {results.map((tab) => (
            <button
              aria-current={tab.id === activeTabId ? "true" : undefined}
              className="terminal-tab-picker-result"
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              type="button"
            >
              <Icon name={tab.id === activeTabId ? "check" : "terminal"} size={16} />
              <span>
                <strong>{tab.label}</strong>
                <small>{tab.cwd}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

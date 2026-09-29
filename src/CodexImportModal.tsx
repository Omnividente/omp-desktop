import { useLayoutEffect, useRef } from "react"
import { Icon } from "./Icon"
import { ImportModeSelect } from "./ImportModeSelect"
import { t, type Lang } from "./i18n"
import type { CodexSessionSummary, ImportMode } from "./types"
import { formatRelative } from "./uiUtils"
import { useModalFocus } from "./useModalFocus"
import { useVirtualList } from "./useVirtualList"

const codexSessionKey = (session: CodexSessionSummary) => session.filePath

interface CodexImportModalProps {
  language: Lang
  loading: boolean
  importing: boolean
  mode: ImportMode
  sessions: CodexSessionSummary[]
  selected: Record<string, boolean>
  onClose: () => void
  onImport: () => void
  onModeChange: (mode: ImportMode) => void
  onSelectedChange: (selected: Record<string, boolean>) => void
}

export function CodexImportModal({
  language,
  loading,
  importing,
  mode,
  sessions,
  selected,
  onClose,
  onImport,
  onModeChange,
  onSelectedChange,
}: CodexImportModalProps) {
  const panelRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pendingFocusRef = useRef<number | null>(null)
  const { virtualItems, totalHeight, measureElement, scrollToIndex } = useVirtualList(
    sessions,
    listRef,
    { estimatedRowHeight: 86, itemGap: 8, getItemKey: codexSessionKey, measurementKey: sessions },
  )
  useLayoutEffect(() => {
    const index = pendingFocusRef.current
    if (index === null) return
    const input = listRef.current?.querySelector<HTMLInputElement>(
      `[data-virtual-index="${index}"] input`,
    )
    if (!input) return
    pendingFocusRef.current = null
    input.focus({ preventScroll: true })
  })
  const focusAdjacent = (index: number, key: string) => {
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? sessions.length - 1
          : index + (key === "ArrowDown" ? 1 : -1)
    if (next < 0 || next >= sessions.length) return
    const input = listRef.current?.querySelector<HTMLInputElement>(
      `[data-virtual-index="${next}"] input`,
    )
    if (input) {
      input.focus()
    } else {
      pendingFocusRef.current = next
      scrollToIndex(next)
    }
  }
  let hasSelection = false
  for (const path in selected) {
    if (Object.hasOwn(selected, path) && selected[path]) {
      hasSelection = true
      break
    }
  }
  const onKeyDown = useModalFocus(panelRef, onClose, { canClose: !importing })
  const close = () => {
    if (!importing) onClose()
  }

  const selectAll = () => {
    onSelectedChange(Object.fromEntries(sessions.map((session) => [session.filePath, true])))
  }

  return (
    <div className="settings-backdrop" onMouseDown={close} role="presentation">
      <section
        aria-labelledby="codex-import-title"
        aria-modal="true"
        className="settings-panel codex-import-panel"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">Codex</span>
            <h2 id="codex-import-title">{t(language, "codexImportTitle")}</h2>
          </div>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            disabled={importing}
            onClick={close}
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
            <div className="codex-list" ref={listRef}>
              <div
                className="codex-list-contents"
                style={{ height: totalHeight, position: "relative" }}
              >
                {virtualItems.map(({ item: session, index, offset }) => (
                  <label
                    className="codex-item"
                    data-virtual-index={index}
                    key={session.filePath}
                    ref={measureElement}
                    style={{ position: "absolute", top: offset, left: 0, right: 0 }}
                  >
                    <input
                      checked={Boolean(selected[session.filePath])}
                      onChange={(event) =>
                        onSelectedChange({
                          ...selected,
                          [session.filePath]: event.target.checked,
                        })
                      }
                      onKeyDown={(event) => {
                        if (
                          event.altKey ||
                          event.ctrlKey ||
                          event.metaKey ||
                          !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                        )
                          return
                        event.preventDefault()
                        event.stopPropagation()
                        focusAdjacent(index, event.key)
                      }}
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
            </div>
          )}
          <ImportModeSelect
            disabled={importing}
            language={language}
            mode={mode}
            onChange={onModeChange}
          />
        </div>
        <footer className="settings-actions">
          <button
            className="button secondary"
            disabled={loading || importing || sessions.length === 0}
            onClick={selectAll}
            type="button"
          >
            {t(language, "selectAll")}
          </button>
          <button
            className="button primary"
            disabled={importing || !hasSelection}
            onClick={onImport}
            type="button"
          >
            {importing ? t(language, "saving") : t(language, "importSelected")}
          </button>
        </footer>
      </section>
    </div>
  )
}

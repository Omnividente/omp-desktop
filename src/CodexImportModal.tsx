import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { Icon } from "./Icon"
import { ImportModeSelect } from "./ImportModeSelect"
import { t, type Lang } from "./i18n"
import type { CodexSessionSummary, ImportMode } from "./types"
import { formatRelative } from "./uiUtils"
import { useModalFocus } from "./useModalFocus"
import { useVirtualList } from "./useVirtualList"

const codexSessionKey = (session: CodexSessionSummary) => session.filePath

interface CodexImportModalProps {
  failures?: Record<string, string>
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

const FAILURE_PAGE_SIZE = 20

const NO_FAILURES: Record<string, string> = {}

export function CodexImportModal({
  failures = NO_FAILURES,
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
  const reportRef = useRef<HTMLElement>(null)
  const [requestedPage, setRequestedPage] = useState(0)
  const failedSessions = useMemo(
    () => sessions.filter((session) => Object.hasOwn(failures, session.filePath)),
    [sessions, failures],
  )
  const failurePages = useMemo(
    () =>
      new Map(
        failedSessions.map((session, index) => [
          session.filePath,
          Math.floor(index / FAILURE_PAGE_SIZE),
        ]),
      ),
    [failedSessions],
  )
  const lastPage = Math.max(0, Math.ceil(failedSessions.length / FAILURE_PAGE_SIZE) - 1)
  const page = Math.min(requestedPage, lastPage)
  const pageStart = page * FAILURE_PAGE_SIZE
  const pageEnd = Math.min(pageStart + FAILURE_PAGE_SIZE, failedSessions.length)
  useLayoutEffect(() => {
    setRequestedPage(page)
    if (reportRef.current) reportRef.current.scrollTop = 0
  }, [page])
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
    const currentIndex = pendingFocusRef.current ?? index
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? sessions.length - 1
          : currentIndex + (key === "ArrowDown" ? 1 : -1)
    if (next < 0 || next >= sessions.length) return
    const input = listRef.current?.querySelector<HTMLInputElement>(
      `[data-virtual-index="${next}"] input`,
    )
    if (input) {
      if (pendingFocusRef.current !== null) scrollToIndex(next)
      pendingFocusRef.current = null
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
          {loading && sessions.length > 0 && (
            <p className="field-help" role="status">
              {t(language, "loading")}
            </p>
          )}
          {failedSessions.length > 0 && (
            <p className="field-help" role="alert">
              {t(language, "importFailedItems").replace("{count}", String(failedSessions.length))}
            </p>
          )}
          {failedSessions.length > 0 && (
            <section
              aria-label={t(language, "importFailureDetails")}
              className="codex-import-failures"
              tabIndex={0}
              ref={reportRef}
            >
              <nav aria-label={t(language, "importFailurePages")} className="codex-import-pages">
                <button
                  type="button"
                  className="button secondary"
                  aria-disabled={page === 0}
                  onClick={() => setRequestedPage(Math.max(0, page - 1))}
                >
                  {t(language, "importFailurePrevious")}
                </button>
                <span role="status">
                  {t(language, "importFailureRange")
                    .replace("{start}", String(pageStart + 1))
                    .replace("{end}", String(pageEnd))
                    .replace("{count}", String(failedSessions.length))}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  aria-disabled={page === lastPage}
                  onClick={() => setRequestedPage(Math.min(lastPage, page + 1))}
                >
                  {t(language, "importFailureNext")}
                </button>
              </nav>
              <ul>
                {failedSessions.slice(pageStart, pageEnd).map((session) => (
                  <li key={session.filePath}>
                    <strong>{session.title}</strong>
                    <small>{session.filePath}</small>
                    <span className="codex-import-error">{failures[session.filePath]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="codex-list" ref={listRef} aria-busy={loading}>
            {sessions.length === 0 ? (
              <p className="field-help" role="status">
                {t(language, loading ? "loading" : "noCodexSessions")}
              </p>
            ) : (
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
                      aria-describedby={
                        Object.hasOwn(failures, session.filePath)
                          ? `codex-import-description-${index}`
                          : undefined
                      }
                      checked={Boolean(selected[session.filePath])}
                      onFocus={() => {
                        const failurePage = failurePages.get(session.filePath)
                        if (failurePage !== undefined) setRequestedPage(failurePage)
                      }}
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
                      {Object.hasOwn(failures, session.filePath) && (
                        <span
                          aria-hidden="true"
                          className="sr-only"
                          id={`codex-import-description-${index}`}
                        >
                          {failures[session.filePath]}
                        </span>
                      )}
                      <strong>{session.title}</strong>
                      <small>
                        {Object.hasOwn(failures, session.filePath) &&
                          `${t(language, "importItemFailed")} · `}
                        {session.cwd} · {formatRelative(session.updatedAt, language)}
                        {session.model ? ` · ${session.model}` : ""}
                      </small>
                      {session.preview && <em>{session.preview}</em>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
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

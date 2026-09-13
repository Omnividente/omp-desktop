import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import type { SessionSummary, SessionTranscript } from "./types"
import type { Lang } from "./i18n"
import { Icon } from "./Icon"
import { t } from "./i18n"
import { useVirtualList } from "./useVirtualList"
import { LinkedText, linkedTextContent, type TextMatch } from "./LinkedText"
import { ContentActionMenu } from "./ContentActionMenu"
import { errorMessage, openContentLink } from "./api"

interface TranscriptModalProps {
  lang: Lang
  transcriptSession: SessionSummary
  transcript: SessionTranscript | null
  transcriptLoading: boolean
  transcriptError: string | null
  transcriptSearch: string
  transcriptMode: "dialogue" | "all"
  launching: string | null
  runtimeAvailable: boolean
  visibleEntries: Array<SessionTranscript["entries"][number]>
  onClose: () => void
  onRefresh: () => void
  onError: (message: string) => void
  onReread: () => void
  onSearchChange: (value: string) => void
  onClearSearch: () => void
  onModeChange: (mode: "dialogue" | "all") => void
}

const transcriptEntryKey = (entry: SessionTranscript["entries"][number]): string => entry.id

export function TranscriptModal({
  lang,
  transcriptSession,
  transcript,
  transcriptLoading,
  transcriptError,
  transcriptSearch,
  transcriptMode,
  launching,
  runtimeAvailable,
  visibleEntries,
  onClose,
  onRefresh,
  onError,
  onReread,
  onSearchChange,
  onClearSearch,
  onModeChange,
}: TranscriptModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{
    left: number
    top: number
    text?: string
    uri?: string
    focus: HTMLElement | null
  } | null>(null)
  const sessionPath = transcript?.session.filePath ?? transcriptSession.filePath
  const openLink = useCallback(
    (uri: string, action: "open" | "reveal" = "open") => {
      void openContentLink(uri, sessionPath, action).catch((error) => {
        onError(errorMessage(error, lang, { includeDetails: true }))
      })
    },
    [sessionPath, onError, lang],
  )

  const virtualLayoutKey = useMemo(
    () => ({ lang, transcript, transcriptMode }),
    [lang, transcript, transcriptMode],
  )
  const { measureElement, virtualItems, totalHeight, scrollToIndex } = useVirtualList(
    visibleEntries,
    scrollRef,
    {
      estimatedRowHeight: 92,
      getItemKey: transcriptEntryKey,
      itemGap: 10,
      measurementKey: virtualLayoutKey,
      overscan: 10,
    },
  )

  const totalOriginal = transcript?.entries.length ?? 0
  const contents = useMemo(
    () =>
      visibleEntries.map((entry) =>
        linkedTextContent((transcriptMode === "dialogue" ? entry.dialogueText : entry.text) ?? ""),
      ),
    [visibleEntries, transcriptMode],
  )
  const search = useMemo(() => {
    const byEntry: TextMatch[][] = contents.map(() => [])
    const occurrences: Array<TextMatch & { entryIndex: number }> = []
    if (transcriptSearch) {
      const pattern = new RegExp(transcriptSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
      contents.forEach((content, entryIndex) => {
        for (const found of content.text.matchAll(pattern)) {
          const match = {
            start: found.index,
            end: found.index + found[0].length,
            index: occurrences.length,
            entryIndex,
          }
          occurrences.push(match)
          byEntry[entryIndex].push(match)
        }
      })
    }
    return { byEntry, occurrences }
  }, [contents, transcriptSearch])
  const [navigation, setNavigation] = useState({ search, index: 0 })
  const currentIndex = search.occurrences.length
    ? navigation.search === search
      ? navigation.index
      : 0
    : -1
  const currentMatch = search.occurrences[currentIndex]
  const navigate = (direction: number) => {
    if (!search.occurrences.length) return
    setNavigation({
      search,
      index: (currentIndex + direction + search.occurrences.length) % search.occurrences.length,
    })
  }
  const pendingMatchRef = useRef<{ index: number; entryIndex: number } | null>(null)
  useLayoutEffect(() => {
    pendingMatchRef.current =
      currentMatch ?? (!transcriptSearch ? { index: -1, entryIndex: 0 } : null)
  }, [currentMatch, navigation, transcriptSearch, transcriptMode, transcript])
  useLayoutEffect(() => {
    const pending = pendingMatchRef.current
    if (pending === null) return
    // Reconcile estimated row offsets only while navigating. Later measurements
    // must not pull the reader back to the current match after manual scrolling.
    scrollToIndex(pending.entryIndex)
    if (pending.index < 0) {
      pendingMatchRef.current = null
      return
    }
    const scroll = scrollRef.current
    const mark = scroll?.querySelector<HTMLElement>(`mark[data-match-index="${pending.index}"]`)
    if (!scroll || !mark) return
    const frame = window.requestAnimationFrame(() => {
      const bounds = scroll.getBoundingClientRect()
      const matchBounds = mark.getBoundingClientRect()
      if (matchBounds.top < bounds.top || matchBounds.bottom > bounds.bottom) {
        scroll.scrollTop += matchBounds.top - bounds.top - scroll.clientHeight / 2
        scroll.dispatchEvent(new Event("scroll"))
      }
      pendingMatchRef.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  })
  useEffect(() => {
    setMenu(null)
  }, [sessionPath, transcript, transcriptMode, transcriptSearch])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const dismissMenu = (restoreFocus: boolean) => {
    if (restoreFocus)
      (menu?.focus?.isConnected ? menu.focus : panelRef.current)?.focus({ preventScroll: true })
    setMenu(null)
  }
  const copySelection = () => {
    if (menu?.text === undefined) return
    void writeText(menu.text).catch((error) => onError(errorMessage(error, lang)))
    dismissMenu(true)
  }

  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="transcript-title"
        aria-modal="true"
        className="settings-panel transcript-panel"
        ref={panelRef}
        tabIndex={-1}
        onKeyDownCapture={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.code === "KeyF"
          ) {
            event.preventDefault()
            event.stopPropagation()
            searchRef.current?.focus()
            searchRef.current?.select()
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-header transcript-header">
          <div>
            <span className="eyebrow">{t(lang, "transcript")}</span>
            <h2 id="transcript-title">{transcript?.session.title ?? transcriptSession.title}</h2>
            <small title={transcript?.session.filePath ?? transcriptSession.filePath}>
              {transcript?.session.filePath ?? transcriptSession.filePath}
            </small>
          </div>
          <div className="transcript-header-actions">
            <button
              className="button secondary transcript-reread-button"
              disabled={launching !== null || !runtimeAvailable}
              onClick={onReread}
              type="button"
            >
              <Icon name="terminal" size={14} />
              {t(lang, "transcriptOpenAndReread")}
            </button>
            <button
              className={`icon-button${transcriptLoading ? " is-spinning" : ""}`}
              disabled={transcriptLoading}
              onClick={onRefresh}
              title={t(lang, "transcriptRefresh")}
              type="button"
            >
              <Icon name="refresh" />
            </button>
            <button
              className="icon-button"
              onClick={onClose}
              title={t(lang, "close")}
              type="button"
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        {transcript?.truncated && (
          <div className="transcript-truncated" role="status">
            <Icon name="alert" size={14} />
            <span>{t(lang, "transcriptTruncated")}</span>
          </div>
        )}
        {transcript && transcript.malformedRecords > 0 && (
          <div className="transcript-truncated" role="status">
            <Icon name="alert" size={14} />
            <span>
              {t(lang, "transcriptMalformedRecords").replace(
                "{count}",
                String(transcript.malformedRecords),
              )}
            </span>
          </div>
        )}
        {transcript?.incompleteLastRecord && (
          <div className="transcript-truncated" role="status">
            <Icon name="alert" size={14} />
            <span>{t(lang, "transcriptIncompleteLastRecord")}</span>
          </div>
        )}

        {transcript && transcript.entries.length > 0 && (
          <div className="transcript-toolbar">
            <div className="transcript-search-field" role="search">
              <Icon name="search" size={14} />
              <input
                aria-label={t(lang, "transcriptSearch")}
                ref={searchRef}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  event.stopPropagation()
                  navigate(event.shiftKey ? -1 : 1)
                }}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={t(lang, "transcriptSearch")}
                spellCheck={false}
                type="search"
                value={transcriptSearch}
              />
              {transcriptSearch && (
                <button
                  aria-label={t(lang, "clearSearch")}
                  onClick={onClearSearch}
                  title={t(lang, "clearSearch")}
                  type="button"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            <div className="transcript-find-navigation">
              <span aria-live="polite" role="status" aria-label={t(lang, "transcriptMatchCount")}>
                {currentIndex + 1} / {search.occurrences.length}
              </span>
              <button
                type="button"
                disabled={!search.occurrences.length}
                onClick={() => navigate(-1)}
                aria-label={t(lang, "transcriptPreviousMatch")}
                title={t(lang, "transcriptPreviousMatch")}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={!search.occurrences.length}
                onClick={() => navigate(1)}
                aria-label={t(lang, "transcriptNextMatch")}
                title={t(lang, "transcriptNextMatch")}
              >
                ↓
              </button>
              {transcriptSearch && !search.occurrences.length && (
                <span>{t(lang, "transcriptNoMatches")}</span>
              )}
            </div>
            <div
              aria-label={t(lang, "transcriptFilter")}
              className="transcript-filter"
              role="group"
            >
              <button
                aria-pressed={transcriptMode === "dialogue"}
                className={transcriptMode === "dialogue" ? "is-active" : undefined}
                onClick={() => onModeChange("dialogue")}
                type="button"
              >
                {t(lang, "transcriptDialogueOnly")}
              </button>
              <button
                aria-pressed={transcriptMode === "all"}
                className={transcriptMode === "all" ? "is-active" : undefined}
                onClick={() => onModeChange("all")}
                type="button"
              >
                {t(lang, "transcriptWithService")}
              </button>
            </div>
          </div>
        )}

        <div
          className="transcript-scroll"
          ref={scrollRef}
          onMouseDownCapture={(event) => {
            if (event.button !== 2) return
            const selection = window.getSelection()
            if (
              selection &&
              !selection.isCollapsed &&
              event.currentTarget.contains(selection.anchorNode) &&
              event.currentTarget.contains(selection.focusNode)
            )
              event.preventDefault()
          }}
          onContextMenu={(event) => {
            const selection = window.getSelection()
            if (!selection || selection.isCollapsed || !selection.rangeCount) return
            const range = selection.getRangeAt(0)
            if (
              !scrollRef.current?.contains(range.startContainer) ||
              !scrollRef.current.contains(range.endContainer)
            )
              return
            const text = selection.toString()
            if (!text) return
            event.preventDefault()
            setMenu({
              left: event.clientX,
              top: event.clientY,
              text,
              focus: document.activeElement as HTMLElement | null,
            })
          }}
        >
          {transcriptLoading ? (
            <div aria-live="polite" className="transcript-state">
              <span className="mini-loader" />
              <strong>{t(lang, "transcriptLoading")}</strong>
            </div>
          ) : transcriptError ? (
            <div className="transcript-state is-error" role="alert">
              <Icon name="alert" size={22} />
              <strong>{t(lang, "transcriptError")}</strong>
              <span>{transcriptError}</span>
              <button className="button secondary" onClick={onRefresh} type="button">
                <Icon name="refresh" size={14} />
                {t(lang, "retry")}
              </button>
            </div>
          ) : !transcript || transcript.entries.length === 0 ? (
            <div className="transcript-state">
              <Icon name="history" size={24} />
              <strong>{t(lang, "transcriptEmpty")}</strong>
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="transcript-state">
              <Icon name="search" size={24} />
              <strong>{t(lang, "transcriptNoMatches")}</strong>
              {transcriptSearch && (
                <button className="button secondary" onClick={onClearSearch} type="button">
                  {t(lang, "clearSearch")}
                </button>
              )}
            </div>
          ) : (
            <div
              className="transcript-entries"
              style={{ height: totalHeight, position: "relative" }}
            >
              {virtualItems.map((vi) => {
                const entry = vi.item
                return (
                  <article
                    key={entry.id}
                    className="transcript-entry"
                    data-category={entry.category}
                    data-role={entry.role}
                    data-virtual-index={vi.index}
                    ref={measureElement}
                    style={{
                      position: "absolute",
                      top: vi.offset,
                      left: 0,
                      right: 0,
                    }}
                  >
                    <header>
                      <strong>{transcriptRoleLabelLocal(entry.role, lang)}</strong>
                      <span className="transcript-entry-meta">
                        {entry.kind && <span>{entry.kind}</span>}
                        {entry.model && <span>{entry.model}</span>}
                        <time dateTime={entry.timestamp}>
                          {formatTimestampLocal(entry.timestamp, lang)}
                        </time>
                      </span>
                    </header>
                    <LinkedText
                      onOpen={openLink}
                      text={contents[vi.index]}
                      matches={search.byEntry[vi.index]}
                      currentMatch={currentIndex}
                      onLinkContextMenu={(event, uri) => {
                        const selection = window.getSelection()
                        if (
                          selection &&
                          !selection.isCollapsed &&
                          scrollRef.current?.contains(selection.anchorNode) &&
                          scrollRef.current.contains(selection.focusNode)
                        )
                          return
                        event.preventDefault()
                        event.stopPropagation()
                        setMenu({
                          left: event.clientX,
                          top: event.clientY,
                          uri,
                          focus: event.currentTarget,
                        })
                      }}
                    />
                  </article>
                )
              })}
            </div>
          )}
        </div>

        {transcript && (
          <footer className="transcript-footer">
            <span>
              {t(lang, "transcriptShown")}: {visibleEntries.length} / {totalOriginal}
            </span>
            <span>
              {t(lang, "transcriptUpdated")}: {formatTimestampLocal(transcript.updatedAt, lang)}
            </span>
          </footer>
        )}
        {menu && (
          <ContentActionMenu
            left={menu.left}
            top={menu.top}
            onDismiss={dismissMenu}
            actions={
              menu.uri !== undefined
                ? [
                    {
                      label: t(lang, "contentLinkOpen"),
                      run: () => {
                        openLink(menu.uri!, "open")
                        dismissMenu(true)
                      },
                    },
                    {
                      label: t(lang, "contentLinkReveal"),
                      run: () => {
                        openLink(menu.uri!, "reveal")
                        dismissMenu(true)
                      },
                    },
                  ]
                : [{ label: t(lang, "copySelection"), run: copySelection }]
            }
          />
        )}
      </section>
    </div>
  )
}

// Minimal local label/time formatters to keep SessionRow/TranscriptModal self-contained
// and avoid exporting trivial wrappers from shared modules.
function transcriptRoleLabelLocal(role: string, lang: Lang): string {
  switch (role.trim().toLocaleLowerCase("en-US")) {
    case "user":
      return t(lang, "transcriptRoleUser")
    case "assistant":
      return t(lang, "transcriptRoleAssistant")
    case "system":
      return t(lang, "transcriptRoleSystem")
    case "tool":
      return t(lang, "transcriptRoleTool")
    default:
      return role.trim() || t(lang, "transcriptRoleOther")
  }
}

function formatTimestampLocal(timestamp: string | number, lang: Lang): string {
  const numeric =
    typeof timestamp === "number" && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
  const date = new Date(numeric)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  return new Intl.DateTimeFormat(lang === "en" ? "en" : "ru", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date)
}

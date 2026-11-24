import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react"
import { errorMessage, openContentLink, readSessionAnswers } from "./api"
import { ContentActionMenu } from "./ContentActionMenu"
import { CopyButton } from "./CopyButton"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import { MarkdownContent, markdownContent } from "./MarkdownContent"
import type { SessionTranscript } from "./types"
import "./CompletedAnswers.css"

interface CompletedAnswersProps {
  active: boolean
  busy: boolean
  version: number
  sessionPath: string
  expandFill: boolean
  lang: Lang
  onError: (message: string) => void
}

interface AnswersState {
  transcript: SessionTranscript
  selectedId: string | undefined
  collapsed: boolean
  contentRequested: boolean
}

export function CompletedAnswers({
  active,
  busy,
  version,
  sessionPath,
  expandFill,
  lang,
  onError,
}: CompletedAnswersProps) {
  const [answers, setAnswers] = useState<AnswersState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [menu, setMenu] = useState<{
    left: number
    top: number
    uri: string
    focus: HTMLAnchorElement
  } | null>(null)
  const bodyId = useId()

  useEffect(() => {
    if (!active || busy) return
    let cancelled = false
    void readSessionAnswers(sessionPath).then(
      (transcript) => {
        if (cancelled) return
        setError(null)
        setAnswers((current) => {
          const latestId = transcript.entries.at(-1)?.id
          const newAnswer = latestId !== current?.transcript.entries.at(-1)?.id
          return {
            transcript,
            selectedId:
              !newAnswer && transcript.entries.some((entry) => entry.id === current?.selectedId)
                ? current?.selectedId
                : latestId,
            collapsed: newAnswer ? true : (current?.collapsed ?? true),
            contentRequested: newAnswer ? false : (current?.contentRequested ?? false),
          }
        })
      },
      (failure) => {
        if (!cancelled) setError(errorMessage(failure, lang))
      },
    )
    return () => {
      cancelled = true
    }
  }, [active, busy, version, sessionPath, lang, refresh])

  const entries = answers?.transcript.entries ?? []
  const index = entries.findIndex((entry) => entry.id === answers?.selectedId)
  const entry = entries[index]
  const source = entry?.dialogueText ?? entry?.text ?? ""
  const content = useMemo(
    () => (answers?.contentRequested ? markdownContent(source) : null),
    [source, answers?.contentRequested],
  )
  const collapsed = answers?.collapsed ?? true
  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const manageFocusRef = useRef(false)

  useEffect(() => setMenu(null), [active, busy, entry?.id, collapsed])

  useEffect(() => {
    if (!manageFocusRef.current) return
    manageFocusRef.current = false
    if (!sectionRef.current?.contains(document.activeElement)) return
    if (collapsed) {
      document
        .querySelector<HTMLTextAreaElement>(".terminal-pane.is-active .xterm-helper-textarea")
        ?.focus()
    } else {
      bodyRef.current?.focus()
    }
  }, [collapsed])

  const openLink = useCallback(
    (uri: string, action: "open" | "reveal" = "open") => {
      void openContentLink(uri, sessionPath, action).catch((failure) => {
        onError(errorMessage(failure, lang, { includeDetails: true }))
      })
    },
    [sessionPath, onError, lang],
  )
  const showLinkMenu = useCallback((event: MouseEvent<HTMLAnchorElement>, uri: string) => {
    if (!window.getSelection()?.isCollapsed) return
    event.preventDefault()
    setMenu({ left: event.clientX, top: event.clientY, uri, focus: event.currentTarget })
  }, [])
  const dismissMenu = (restoreFocus: boolean) => {
    if (restoreFocus && menu?.focus.isConnected) menu.focus.focus()
    setMenu(null)
  }
  const select = (offset: -1 | 1) => {
    setAnswers((current) => {
      if (!current) return current
      const entries = current.transcript.entries
      const index = entries.findIndex((entry) => entry.id === current.selectedId)
      const next = entries[index + offset]
      return next
        ? { ...current, selectedId: next.id, collapsed: false, contentRequested: true }
        : current
    })
  }
  const selectLatest = () => {
    setAnswers((current) => {
      const latest = current?.transcript.entries.at(-1)
      return current && latest
        ? { ...current, selectedId: latest.id, collapsed: false, contentRequested: true }
        : current
    })
  }

  const toggle = () => {
    manageFocusRef.current = true
    setAnswers(
      (current) =>
        current && {
          ...current,
          collapsed: !current.collapsed,
          contentRequested: true,
        },
    )
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key !== "Escape" || collapsed) return
    event.preventDefault()
    manageFocusRef.current = true
    setAnswers((current) => current && { ...current, collapsed: true })
  }

  if (busy || (!entry && !error)) return null

  return (
    <section
      className={`completed-answers${!collapsed && expandFill ? " is-expanded" : ""}`}
      aria-label={t(lang, "completedAnswer")}
      onKeyDown={handleKeyDown}
      ref={sectionRef}
    >
      <header className="completed-answers-toolbar">
        <strong>{t(lang, "completedAnswer")}</strong>
        {entry && (
          <>
            <nav aria-label={t(lang, "completedAnswer")}>
              <button
                type="button"
                className="completed-answer-previous"
                aria-label={t(lang, "completedAnswerPrevious")}
                title={t(lang, "completedAnswerPrevious")}
                disabled={index <= 0}
                onClick={() => select(-1)}
              >
                <Icon name="chevron" size={14} />
              </button>
              <span>
                {index + 1} / {entries.length}
              </span>
              <button
                type="button"
                aria-label={t(lang, "completedAnswerNext")}
                title={t(lang, "completedAnswerNext")}
                disabled={index >= entries.length - 1}
                onClick={() => select(1)}
              >
                <Icon name="chevron" size={14} />
              </button>
              {entries.length > 1 && (
                <button type="button" onClick={selectLatest}>
                  {t(lang, "completedAnswerLatest")}
                </button>
              )}
            </nav>
            {!collapsed && content && (
              <>
                <CopyButton
                  scope={entry}
                  text={content.text}
                  label={t(lang, "copyMessage")}
                  lang={lang}
                  onError={onError}
                />
                <CopyButton
                  scope={entry}
                  text={source}
                  label={t(lang, "copyMarkdown")}
                  lang={lang}
                  onError={onError}
                />
              </>
            )}
            <button
              className="completed-answer-toggle"
              type="button"
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              onClick={toggle}
            >
              {t(lang, collapsed ? "completedAnswerShow" : "completedAnswerHide")}
            </button>
          </>
        )}
      </header>
      {error && (
        <div className="completed-answer-warning" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setRefresh((current) => current + 1)}>
            {t(lang, "transcriptRefresh")}
          </button>
        </div>
      )}
      <div
        className="completed-answer-body"
        id={bodyId}
        hidden={collapsed}
        key={entry?.id}
        ref={bodyRef}
        tabIndex={0}
      >
        {answers?.transcript.truncated && (
          <p className="completed-answer-warning">{t(lang, "transcriptTruncated")}</p>
        )}
        {!!answers?.transcript.malformedRecords && (
          <p className="completed-answer-warning">
            {t(lang, "transcriptMalformedRecords").replace(
              "{count}",
              String(answers.transcript.malformedRecords),
            )}
          </p>
        )}
        {answers?.transcript.incompleteLastRecord && (
          <p className="completed-answer-warning">{t(lang, "transcriptIncompleteLastRecord")}</p>
        )}
        {entry && content && (
          <MarkdownContent
            content={content}
            lang={lang}
            onError={onError}
            onOpen={openLink}
            onLinkContextMenu={showLinkMenu}
          />
        )}
      </div>
      {active && menu && (
        <ContentActionMenu
          left={menu.left}
          top={menu.top}
          onDismiss={dismissMenu}
          actions={[
            {
              label: t(lang, "contentLinkOpen"),
              run: () => {
                openLink(menu.uri)
                dismissMenu(true)
              },
            },
            {
              label: t(lang, "contentLinkReveal"),
              run: () => {
                openLink(menu.uri, "reveal")
                dismissMenu(true)
              },
            },
          ]}
        />
      )}
    </section>
  )
}

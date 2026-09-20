import { useCallback, useEffect, useId, useMemo, useState } from "react"
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
  lang: Lang
  onError: (message: string) => void
}

interface AnswersState {
  transcript: SessionTranscript
  selectedId: string | undefined
  collapsed: boolean
}

export function CompletedAnswers({
  active,
  busy,
  version,
  sessionPath,
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
            collapsed: newAnswer ? false : (current?.collapsed ?? false),
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
  const content = useMemo(() => markdownContent(source), [source])
  const collapsed = answers?.collapsed ?? false

  useEffect(() => setMenu(null), [active, busy, entry?.id, collapsed])

  const openLink = useCallback(
    (uri: string, action: "open" | "reveal" = "open") => {
      void openContentLink(uri, sessionPath, action).catch((failure) => {
        onError(errorMessage(failure, lang, { includeDetails: true }))
      })
    },
    [sessionPath, onError, lang],
  )
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
      return next ? { ...current, selectedId: next.id, collapsed: false } : current
    })
  }

  if (busy || (!entry && !error)) return null

  return (
    <section className="completed-answers" aria-label={t(lang, "completedAnswer")}>
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
            </nav>
            {!collapsed && (
              <>
                <CopyButton
                  text={content.text}
                  label={t(lang, "copyMessage")}
                  lang={lang}
                  onError={onError}
                />
                <CopyButton
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
              onClick={() =>
                setAnswers((current) => current && { ...current, collapsed: !current.collapsed })
              }
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
        {entry && (
          <MarkdownContent
            content={content}
            lang={lang}
            onError={onError}
            onOpen={openLink}
            onLinkContextMenu={(event, uri) => {
              if (!window.getSelection()?.isCollapsed) return
              event.preventDefault()
              setMenu({ left: event.clientX, top: event.clientY, uri, focus: event.currentTarget })
            }}
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

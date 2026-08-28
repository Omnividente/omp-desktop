import React, {
  KeyboardEvent as ReactKeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import type { SessionSummary } from "./types"
import type { Lang } from "./i18n"
import { Icon } from "./Icon"
import { t } from "./i18n"

interface SessionRowProps {
  session: SessionSummary
  lang: Lang
  selected: boolean
  busy: boolean
  renaming: boolean
  sessionOpen: boolean
  sessionRunning: boolean
  sessionThinking: boolean
  deleting: boolean
  actionsDisabled: boolean
  renameValue: string
  launchDisabled: boolean
  depth: number
  hasChildren: boolean
  childrenExpanded: boolean
  onSelect: () => void
  onDoubleLaunch: () => void
  onKeySelect: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  onToggleChildren: () => void
  onLaunch: () => void
  onTranscript: (e: React.MouseEvent) => void
  onStartRename: (e: React.MouseEvent) => void
  onToggleTitlePin: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
  onSubmitRename: () => void
  onRenameChange: (v: string) => void
  onRenameKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
}

export function SessionRow({
  session,
  lang,
  selected,
  busy,
  renaming,
  sessionOpen,
  sessionRunning,
  sessionThinking,
  deleting,
  actionsDisabled,
  renameValue,
  launchDisabled,
  depth,
  hasChildren,
  childrenExpanded,
  onSelect,
  onDoubleLaunch,
  onKeySelect,
  onToggleChildren,
  onLaunch,
  onTranscript,
  onStartRename,
  onToggleTitlePin,
  onDelete,
  onSubmitRename,
  onRenameChange,
  onRenameKeyDown,
}: SessionRowProps) {
  const titleAnchorRef = useRef<HTMLDivElement>(null)
  const titleTooltipId = useId()
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false)
  const [titleTooltipPosition, setTitleTooltipPosition] = useState({
    left: 0,
    top: 0,
    width: 240,
    above: false,
  })

  useLayoutEffect(() => {
    if (!titleTooltipOpen) return undefined
    const updatePosition = () => {
      const bounds = titleAnchorRef.current?.getBoundingClientRect()
      if (!bounds) return
      const width = Math.min(520, Math.max(240, bounds.width), window.innerWidth - 24)
      const left = Math.min(Math.max(12, bounds.left), window.innerWidth - width - 12)
      const above = bounds.bottom + 110 > window.innerHeight
      setTitleTooltipPosition({
        left,
        top: above ? bounds.top - 7 : bounds.bottom + 7,
        width,
        above,
      })
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [titleTooltipOpen])

  return (
    <>
      <article
        className={`session-item${selected ? " is-selected" : ""}${sessionOpen ? " is-open" : ""}${sessionThinking ? " is-thinking" : ""}${renaming ? " is-renaming" : ""}${depth > 0 ? " is-child" : ""}${hasChildren ? " has-children" : ""}`}
      >
        {!renaming &&
          (hasChildren ? (
            <button
              aria-expanded={childrenExpanded}
              aria-label={`${t(lang, childrenExpanded ? "collapseSessionGroup" : "expandSessionGroup")}: ${session.title}`}
              className="session-group-toggle"
              onClick={(event) => {
                event.stopPropagation()
                onToggleChildren()
              }}
              title={t(lang, childrenExpanded ? "collapseSessionGroup" : "expandSessionGroup")}
              type="button"
            >
              <Icon name="chevron" size={13} />
            </button>
          ) : (
            <span aria-hidden="true" className="session-group-spacer" />
          ))}

        <div
          aria-pressed={selected}
          aria-describedby={titleTooltipOpen && !renaming ? titleTooltipId : undefined}
          aria-label={session.title}
          className="session-select"
          onBlur={() => setTitleTooltipOpen(false)}
          onClick={onSelect}
          onDoubleClick={onDoubleLaunch}
          onKeyDown={onKeySelect}
          onFocus={() => {
            if (!renaming) setTitleTooltipOpen(true)
          }}
          onMouseEnter={() => {
            if (!renaming) setTitleTooltipOpen(true)
          }}
          onMouseLeave={() => setTitleTooltipOpen(false)}
          role="button"
          tabIndex={0}
          ref={titleAnchorRef}
          style={{ paddingLeft: 9 + depth * 14 }}
        >
          <span className="session-icon">
            <Icon name="history" size={16} />
          </span>
          <span className="session-copy" onClick={onSelect} role="presentation">
            {renaming ? (
              <input
                autoFocus
                className="session-rename"
                onBlur={onSubmitRename}
                onChange={(e) => onRenameChange(e.target.value)}
                onKeyDown={onRenameKeyDown}
                value={renameValue}
              />
            ) : (
              <strong>{session.title}</strong>
            )}
            <small>
              {sessionOpen && (
                <>
                  <span
                    aria-label={
                      sessionThinking
                        ? t(lang, "sessionThinkingTitle")
                        : sessionRunning
                          ? t(lang, "sessionOpenTitle")
                          : t(lang, "sessionOpenShort")
                    }
                    className={`session-live-marker${sessionRunning ? " is-running" : ""}${sessionThinking ? " is-thinking" : ""}`}
                    title={
                      sessionThinking
                        ? t(lang, "sessionThinkingTitle")
                        : sessionRunning
                          ? t(lang, "sessionOpenTitle")
                          : t(lang, "sessionOpenShort")
                    }
                  >
                    <span className="session-live-dot" />
                    {sessionThinking && <b>{t(lang, "thinkingShort")}</b>}
                  </span>
                  <i>·</i>
                </>
              )}
              {formatRelativeLocal(session.updatedAt, lang)}
              <i>·</i>
              {session.model?.split("/").at(-1) ?? t(lang, "noModel")}
              {session.source !== "omp" ? <i>· {session.source}</i> : null}
            </small>
          </span>
        </div>
        {!renaming && (
          <button
            aria-pressed={session.pinnedTitle !== null}
            className={`session-play session-pin${session.pinnedTitle ? " is-pinned" : ""}`}
            disabled={actionsDisabled}
            onClick={onToggleTitlePin}
            title={t(lang, session.pinnedTitle ? "unpinSessionTitle" : "pinSessionTitle")}
            type="button"
          >
            <Icon name="pin" size={14} />
          </button>
        )}
        {!renaming && (
          <button
            className="session-play session-transcript"
            disabled={actionsDisabled}
            onClick={onTranscript}
            title={t(lang, "openTranscript")}
            type="button"
          >
            <Icon name="history" size={14} />
          </button>
        )}
        {!renaming && (
          <button
            className="session-play"
            disabled={actionsDisabled}
            onClick={onStartRename}
            title={t(lang, "editFixedTitle")}
            type="button"
          >
            <Icon name="edit" size={14} />
          </button>
        )}
        {!renaming && (
          <button
            className="session-play session-delete"
            disabled={actionsDisabled || sessionRunning}
            onClick={onDelete}
            title={sessionRunning ? t(lang, "closeSessionBeforeDelete") : t(lang, "deleteSession")}
            type="button"
          >
            {deleting ? <span className="mini-loader" /> : <Icon name="trash" size={14} />}
          </button>
        )}
        {!renaming && (
          <button
            className="session-play"
            disabled={launchDisabled}
            onClick={onLaunch}
            title={t(lang, "resumeSession")}
            type="button"
          >
            {busy ? <span className="mini-loader" /> : <Icon name="play" size={14} />}
          </button>
        )}
      </article>
      {titleTooltipOpen &&
        !renaming &&
        createPortal(
          <div
            className="session-title-tooltip"
            id={titleTooltipId}
            role="tooltip"
            style={{
              left: titleTooltipPosition.left,
              top: titleTooltipPosition.top,
              width: titleTooltipPosition.width,
              transform: titleTooltipPosition.above ? "translateY(-100%)" : undefined,
            }}
          >
            {session.title}
          </div>,
          document.body,
        )}
    </>
  )
}

// Local small relative formatter to avoid cross import cycles; mirrors App's for display only.
function formatRelativeLocal(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков"
  }
  const relativeTime = new Intl.RelativeTimeFormat(lang === "en" ? "en" : "ru", { numeric: "auto" })
  const calendarDate = new Intl.DateTimeFormat(lang === "en" ? "en" : "ru", {
    day: "numeric",
    month: "short",
  })
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absolute = Math.abs(seconds)
  if (absolute < 60) return relativeTime.format(seconds, "second")
  if (absolute < 3_600) return relativeTime.format(Math.round(seconds / 60), "minute")
  if (absolute < 86_400) return relativeTime.format(Math.round(seconds / 3_600), "hour")
  if (absolute < 604_800) return relativeTime.format(Math.round(seconds / 86_400), "day")
  return calendarDate.format(timestamp)
}

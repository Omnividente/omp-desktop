import React, { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SessionSummary } from "./types";
import type { Lang } from "./i18n";
import { Icon } from "./Icon";
import { t } from "./i18n";

interface SessionRowProps {
  session: SessionSummary;
  lang: Lang;
  selected: boolean;
  busy: boolean;
  renaming: boolean;
  sessionOpen: boolean;
  sessionRunning: boolean;
  sessionThinking: boolean;
  deleting: boolean;
  actionsDisabled: boolean;
  renameValue: string;
  launchDisabled: boolean;
  onSelect: () => void;
  onDoubleLaunch: () => void;
  onKeySelect: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onLaunch: () => void;
  onTranscript: (e: React.MouseEvent) => void;
  onStartRename: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onSubmitRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
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
  onSelect,
  onDoubleLaunch,
  onKeySelect,
  onLaunch,
  onTranscript,
  onStartRename,
  onDelete,
  onSubmitRename,
  onRenameChange,
  onRenameKeyDown,
}: SessionRowProps) {
  return (
    <article
      className={`session-item${selected ? " is-selected" : ""}${sessionOpen ? " is-open" : ""}${sessionThinking ? " is-thinking" : ""}`}
    >
      <div
        aria-pressed={selected}
        className="session-select"
        onClick={onSelect}
        onDoubleClick={onDoubleLaunch}
        onKeyDown={onKeySelect}
        role="button"
        tabIndex={0}
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
            {formatRelativeLocal(session.updatedAt, lang)}
            <i>·</i>
            {session.model?.split("/").at(-1) ?? t(lang, "noModel")}
            {session.source !== "omp" ? <i>· {session.source}</i> : null}
          </small>
        </span>
        {sessionOpen && (
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
            <span />
          </span>
        )}
      </div>
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
          disabled={actionsDisabled || sessionRunning}
          onClick={onStartRename}
          title={
            sessionRunning ? t(lang, "closeSessionBeforeRename") : t(lang, "rename")
          }
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
          title={
            sessionRunning ? t(lang, "closeSessionBeforeDelete") : t(lang, "deleteSession")
          }
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
  );
}

// Local small relative formatter to avoid cross import cycles; mirrors App's for display only.
function formatRelativeLocal(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков";
  }
  const relativeTime = new Intl.RelativeTimeFormat(lang === "en" ? "en" : "ru", { numeric: "auto" });
  const calendarDate = new Intl.DateTimeFormat(lang === "en" ? "en" : "ru", {
    day: "numeric",
    month: "short",
  });
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relativeTime.format(seconds, "second");
  if (absolute < 3_600) return relativeTime.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return relativeTime.format(Math.round(seconds / 3_600), "hour");
  if (absolute < 604_800) return relativeTime.format(Math.round(seconds / 86_400), "day");
  return calendarDate.format(timestamp);
}

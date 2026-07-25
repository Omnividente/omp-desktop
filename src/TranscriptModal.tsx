import { useMemo, useRef } from "react";
import type { SessionSummary, SessionTranscript } from "./types";
import type { Lang } from "./i18n";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { useVirtualList } from "./useVirtualList";

interface TranscriptModalProps {
  lang: Lang;
  transcriptSession: SessionSummary;
  transcript: SessionTranscript | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  transcriptSearch: string;
  transcriptMode: "dialogue" | "all";
  launching: string | null;
  runtimeAvailable: boolean;
  visibleEntries: Array<SessionTranscript["entries"][number]>;
  onClose: () => void;
  onRefresh: () => void;
  onReread: () => void;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onModeChange: (mode: "dialogue" | "all") => void;
}

const transcriptEntryKey = (entry: SessionTranscript["entries"][number]): string => entry.id;

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
  onReread,
  onSearchChange,
  onClearSearch,
  onModeChange,
}: TranscriptModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualLayoutKey = useMemo(
    () => ({ lang, transcript, transcriptMode }),
    [lang, transcript, transcriptMode],
  );
  const { measureElement, virtualItems, totalHeight } = useVirtualList(visibleEntries, scrollRef, {
    estimatedRowHeight: 92,
    getItemKey: transcriptEntryKey,
    itemGap: 10,
    measurementKey: virtualLayoutKey,
    overscan: 10,
  });

  const totalOriginal = transcript?.entries.length ?? 0;

  return (
    <div className="settings-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="transcript-title"
        aria-modal="true"
        className="settings-panel transcript-panel"
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
            <button className="icon-button" onClick={onClose} title={t(lang, "close")} type="button">
              <Icon name="close" />
            </button>
          </div>
        </header>

        {transcript && transcript.entries.length > 0 && (
          <div className="transcript-toolbar">
            <div className="transcript-search-field" role="search">
              <Icon name="search" size={14} />
              <input
                aria-label={t(lang, "transcriptSearch")}
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
            <div aria-label={t(lang, "transcriptFilter")} className="transcript-filter" role="group">
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

        <div className="transcript-scroll" ref={scrollRef}>
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
            <div className="transcript-entries" style={{ height: totalHeight, position: "relative" }}>
              {virtualItems.map((vi) => {
                const entry = vi.item;
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
                    <pre>{transcriptMode === "dialogue" ? entry.dialogueText : entry.text}</pre>
                  </article>
                );
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
      </section>
    </div>
  );
}

// Minimal local label/time formatters to keep SessionRow/TranscriptModal self-contained
// and avoid exporting trivial wrappers from shared modules.
function transcriptRoleLabelLocal(role: string, lang: Lang): string {
  switch (role.trim().toLocaleLowerCase("en-US")) {
    case "user":
      return t(lang, "transcriptRoleUser");
    case "assistant":
      return t(lang, "transcriptRoleAssistant");
    case "system":
      return t(lang, "transcriptRoleSystem");
    case "tool":
      return t(lang, "transcriptRoleTool");
    default:
      return role.trim() || t(lang, "transcriptRoleOther");
  }
}

function formatTimestampLocal(timestamp: string | number, lang: Lang): string {
  const numeric =
    typeof timestamp === "number" && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return new Intl.DateTimeFormat(lang === "en" ? "en" : "ru", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

import type { Lang } from "./i18n";
import type { SessionSummary, TerminalTab } from "./types";

type SessionIdentity = Pick<SessionSummary, "id" | "filePath">;

export function localeTag(lang: Lang): string {
  return lang === "en" ? "en" : "ru";
}

export function formatRelative(timestamp: number, lang: Lang): string {
  if (!timestamp) {
    return lang === "en" ? "no runs" : "нет запусков";
  }
  const relativeTime = new Intl.RelativeTimeFormat(localeTag(lang), { numeric: "auto" });
  const calendarDate = new Intl.DateTimeFormat(localeTag(lang), {
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

export function normalizedPath(path: string, platform: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function tabMatchesSession(
  tab: TerminalTab,
  session: SessionIdentity,
  platform: string,
): boolean {
  return (
    tab.sessionId === session.id ||
    Boolean(
      tab.sessionPath &&
        normalizedPath(tab.sessionPath, platform) === normalizedPath(session.filePath, platform),
    )
  );
}

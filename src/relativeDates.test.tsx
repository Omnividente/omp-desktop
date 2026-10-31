/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import { WorkspaceHome } from "./WorkspaceHome"
import { CodexImportModal } from "./CodexImportModal"
import { formatRelative } from "./uiUtils"
import type { SessionSummary } from "./types"

// Node process-local TZ simulates a changed host default; this is not native
// OS/WebView coverage. Components are checked on their next ordinary render.
const originalTimezone = vi.hoisted(() => {
  const timezone = {
    runtime: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    environment: import.meta.env.TZ,
    present: Object.hasOwn(import.meta.env, "TZ"),
  }
  vi.stubEnv("TZ", "UTC")
  return timezone
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const now = Date.parse("2026-10-28T05:00:00Z")
const session: SessionSummary = {
  id: "synthetic",
  title: "Synthetic history",
  pinnedTitle: null,
  cwd: "/synthetic/project",
  projectKey: "project",
  filePath: "/synthetic/history.jsonl",
  parentSessionPath: null,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: Date.parse("2026-10-01T00:30:00Z"),
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
}
let root: Root | undefined
let container: HTMLDivElement | undefined
beforeEach(() => {
  vi.stubEnv("TZ", "UTC")
  vi.spyOn(Date, "now").mockReturnValue(now)
})
afterEach(cleanup)
function cleanup() {
  try {
    if (root) act(() => root!.unmount())
  } finally {
    root = undefined
    container?.remove()
    container = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    restoreTimezone()
  }
}
afterAll(restoreTimezone)
function restoreTimezone() {
  // Windows Node clears the TZ variable without resetting ICU's default zone.
  // Restore that runtime state explicitly before restoring the original raw env.
  vi.stubEnv("TZ", originalTimezone.runtime)
  vi.unstubAllEnvs()
  expect(import.meta.env.TZ).toBe(originalTimezone.environment)
  expect(Object.hasOwn(import.meta.env, "TZ")).toBe(originalTimezone.present)
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(originalTimezone.runtime)
}
const rowProps: Omit<ComponentProps<typeof SessionRow>, "lang" | "session"> = {
  selected: false,
  busy: false,
  renaming: false,
  sessionOpen: false,
  sessionRunning: false,
  sessionThinking: false,
  deleting: false,
  actionsDisabled: false,
  renameValue: "",
  launchDisabled: false,
  depth: 0,
  hasChildren: false,
  childrenExpanded: false,
  onSelect: vi.fn(),
  onDoubleLaunch: vi.fn(),
  onKeySelect: vi.fn(),
  onToggleChildren: vi.fn(),
  onLaunch: vi.fn(),
  onTranscript: vi.fn(),
  onStartRename: vi.fn(),
  onToggleTitlePin: vi.fn(),
  onDelete: vi.fn(),
  onSubmitRename: vi.fn(),
  onRenameChange: vi.fn(),
  onRenameKeyDown: vi.fn(),
}
describe("relative date calendar presentation", () => {
  it("restores timezone after thrown work and repeated cleanup", () => {
    expect(() => {
      try {
        vi.stubEnv("TZ", "America/New_York")
        throw new Error("Synthetic body failure")
      } finally {
        restoreTimezone()
      }
    }).toThrow("Synthetic body failure")
    restoreTimezone()
  })
  it("restores timezone even when unmount throws", () => {
    vi.stubEnv("TZ", "Europe/Paris")
    root = {
      render: vi.fn(),
      unmount: () => {
        throw new Error("Synthetic unmount failure")
      },
    }
    expect(cleanup).toThrow("Synthetic unmount failure")
    restoreTimezone()
  })
  it("keeps Home/import dates aligned with the sidebar after timezone and language changes", async () => {
    expect(formatRelative(session.updatedAt, "en")).toBe("Oct 1")
    vi.stubEnv("TZ", "America/Los_Angeles")
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    for (const lang of ["en", "ru", "en"] as const) {
      await act(async () =>
        root!.render(
          <>
            <SessionRow {...rowProps} lang={lang} session={session} />
            <WorkspaceHome
              primaryActionRef={{ current: null }}
              workspace={{
                key: "project",
                path: session.cwd,
                name: "Synthetic",
                sessionCount: 1,
                lastActive: session.updatedAt,
                pinned: false,
              }}
              sessions={[session]}
              selectedSession={session}
              runtime={{
                platform: "linux",
                arch: "x64",
                language: lang,
                ompAvailable: false,
                ompExecutable: "",
                ompVersion: null,
                sessionRoot: "/synthetic",
              }}
              launching={null}
              lang={lang}
              onLaunch={vi.fn()}
              onReveal={vi.fn()}
              onOpenFolder={vi.fn()}
            />
            <CodexImportModal
              language={lang}
              loading={false}
              importing={false}
              mode="skip"
              sessions={[{ ...session, preview: "Synthetic" }]}
              selected={{}}
              onClose={vi.fn()}
              onImport={vi.fn()}
              onModeChange={vi.fn()}
              onSelectedChange={vi.fn()}
            />
          </>,
        ),
      )
      for (let turn = 0; frames.size && turn < 20; turn++) {
        const batch = [...frames.values()]
        frames.clear()
        await act(async () => {
          for (const callback of batch) callback(turn)
        })
      }
      const expected = lang === "en" ? "Sep 30" : "30 сент."
      expect(container.querySelector(".session-select small")?.textContent).toContain(expected)
      expect(container.querySelector(".recent-copy small")?.textContent).toContain(expected)
      expect(container.querySelector(".stats-grid .stat-text")?.textContent).toBe(expected)
      const importDate = [...container.querySelectorAll(".codex-import-panel small")].find(
        (element) => element.textContent?.includes(session.cwd),
      )
      expect(importDate?.textContent).toContain(expected)
    }
  })
  it.each(["en", "ru"] as const)(
    "matches live Gregorian month/day across zones and calendar boundaries (%s)",
    (lang) => {
      const timestamps = [
        "2026-10-01T00:30:00Z",
        "2026-03-29T00:59:59Z",
        "2026-03-29T01:00:00Z",
        "2024-11-03T01:30:00-04:00",
        "2024-11-03T01:30:00-05:00",
        "2026-01-01T07:30:00Z",
        "1890-01-01T23:50:50Z",
        "2024-02-29T12:00:00Z",
        "0099-02-28T23:30:00Z",
        "0000-02-29T12:00:00Z",
      ]
        .map(Date.parse)
        .concat([-8640000000000000, 8640000000000000])
      for (const timezone of [
        "UTC",
        "Europe/Berlin",
        "Europe/Paris",
        "America/New_York",
        "America/Los_Angeles",
        "America/Phoenix",
        "Asia/Kolkata",
        "Pacific/Kiritimati",
        "Pacific/Pago_Pago",
      ]) {
        vi.stubEnv("TZ", timezone)
        const expected = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" })
        expect(expected.resolvedOptions().calendar).toBe("gregory")
        for (const timestamp of timestamps)
          expect(formatRelative(timestamp, lang)).toBe(expected.format(timestamp))
      }
    },
  )
  it("does not treat equal current offsets as equivalent historical zones", () => {
    const timestamp = Date.parse("2026-01-01T07:30:00Z")
    vi.stubEnv("TZ", "America/Phoenix")
    const phoenixOffset = new Date(now).getTimezoneOffset()
    expect(formatRelative(timestamp, "en")).toBe("Jan 1")
    vi.stubEnv("TZ", "America/Los_Angeles")
    expect(new Date(now).getTimezoneOffset()).toBe(phoenixOffset)
    expect(formatRelative(timestamp, "en")).toBe("Dec 31")
  })
  it("uses local calendar fields rather than rounded offset arithmetic", () => {
    vi.stubEnv("TZ", "Europe/Paris")
    expect(formatRelative(Date.parse("1890-01-01T23:50:50Z"), "en")).toBe("Jan 2")
  })
  it("preserves zero, invalid, relative and future timestamp behavior", () => {
    expect(formatRelative(0, "en")).toBe("no runs")
    expect(formatRelative(Number.NaN, "ru")).toBe("нет запусков")
    expect(() => formatRelative(Infinity, "en")).toThrow(RangeError)
    expect(() => formatRelative(8640000000000001, "ru")).toThrow(RangeError)
    expect(formatRelative(now - 30000, "en")).toBe("30 seconds ago")
    expect(formatRelative(now - 30 * 60000, "en")).toBe("30 minutes ago")
    expect(formatRelative(now - 25 * 3600000, "ru")).toBe("вчера")
    expect(formatRelative(now + 3600000, "en")).toBe("in 1 hour")
  })
  it("reuses cached Intl formatters for repeated calendar and relative labels", () => {
    const dateFormatter = vi.spyOn(Intl, "DateTimeFormat")
    const relativeFormatter = vi.spyOn(Intl, "RelativeTimeFormat")
    for (let index = 1; index <= 1000; index++) {
      formatRelative(now - index * 86400000, index % 2 ? "en" : "ru")
    }
    expect(dateFormatter).not.toHaveBeenCalled()
    expect(relativeFormatter).not.toHaveBeenCalled()
  })
})

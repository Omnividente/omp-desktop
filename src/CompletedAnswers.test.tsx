/** @vitest-environment jsdom */
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { act } from "react"
import { marked } from "marked"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { openContentLink, readSessionAnswers } from "./api"
import { CompletedAnswers } from "./CompletedAnswers"
import { applyRuntimeEventToTab } from "./runtimeEvents"
import type { PtyRuntimeEvent, SessionTranscript, TerminalTab } from "./types"
import { t, type Lang } from "./i18n"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }))

vi.mock("./api", () => ({
  readSessionAnswers: vi.fn(),
  openContentLink: vi.fn().mockResolvedValue(undefined),
  errorMessage: (error: unknown) => String(error),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function transcript(path: string, ...messages: string[]): SessionTranscript {
  return {
    session: {
      id: path,
      title: "Synthetic answers",
      pinnedTitle: null,
      cwd: "/tmp/project",
      projectKey: "project",
      filePath: path,
      parentSessionPath: null,
      createdAt: "2026-01-01",
      updatedAt: 1,
      model: null,
      thinkingLevel: null,
      configuredThinkingLevel: null,
      source: "test",
      hasMessages: true,
      primaryProviderPinned: false,
    },
    entries: messages.map((text, index) => ({
      id: `${path}-${index}`,
      timestamp: "2026-01-01",
      role: "assistant",
      text,
      dialogueText: text,
      category: "dialogue",
    })),
    updatedAt: 1,
    truncated: false,
    malformedRecords: 0,
    incompleteLastRecord: false,
  }
}
function event(activity: "thinking" | "idle"): PtyRuntimeEvent {
  return {
    terminalId: "terminal",
    kind: "activity",
    model: null,
    modelRole: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    activity,
    errorMessage: null,
    fallbackFrom: null,
    fallbackTo: null,
    fallbackRole: null,
    resolvedModelIsFallback: null,
  }
}
const tab: TerminalTab = {
  id: "terminal",
  label: "Test",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "session",
  sessionPath: "/tmp/a.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}
let container: HTMLDivElement
let root: Root
const onError = vi.fn()

async function render(current = tab, active = true, lang: Lang = "en", expandFill = false) {
  await act(async () => {
    root.render(
      <>
        <input aria-label="Draft" defaultValue="Unsent draft" />
        <CompletedAnswers
          key={current.sessionPath}
          sessionPath={current.sessionPath!}
          busy={current.activity === "thinking"}
          active={active}
          version={current.completedResponseVersion ?? 0}
          expandFill={expandFill}
          lang={lang}
          onError={onError}
        />
      </>,
    )
  })
}
function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  )
  expect(result).toBeDefined()
  return result!
}

beforeEach(() => {
  vi.resetAllMocks()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll(".terminal-pane").forEach((node) => node.remove())
})

it("keeps new answers collapsed after batched thinking/idle without stealing focus", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# First answer"))
  await render()
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
  await render(tab, false)
  await render()
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")

  const input = container.querySelector("input")!
  input.focus()
  vi.mocked(readSessionAnswers).mockResolvedValue(
    transcript(tab.sessionPath!, "# First answer", "## Second answer"),
  )
  // App reduces both events before React sees a tab; its final activity is still idle.
  const completed = [event("thinking"), event("idle")].reduce(applyRuntimeEventToTab, tab)
  await render(completed)
  expect(container.querySelector("h2")).toBeNull()
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe("Unsent draft")
  await act(async () => button("Show answer").click())
  expect(container.querySelector("h2")?.textContent).toBe("Second answer")
  await act(async () => button("Previous answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("First answer")
})

it("fills the pane only when the expand-fill setting is enabled", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# Answer"))
  await render(tab, true, "en", false)
  await act(async () => button("Show answer").click())
  expect(container.querySelector(".completed-answers")?.classList.contains("is-expanded")).toBe(
    false,
  )

  await render(tab, true, "en", true)
  expect(container.querySelector(".completed-answers")?.classList.contains("is-expanded")).toBe(
    true,
  )
  await act(async () => button("Collapse answer").click())
  expect(container.querySelector(".completed-answers")?.classList.contains("is-expanded")).toBe(
    false,
  )
})

it("navigates from the current answer when a refresh and a click are batched", async () => {
  const path = tab.sessionPath!
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(
    transcript(path, "# First answer", "# Second answer"),
  )
  await render()

  let resolveRefresh!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRefresh = resolve
    }),
  )
  await render({ ...tab, completedResponseVersion: 1 })
  await act(async () => {
    resolveRefresh(transcript(path, "# First answer", "# Second answer", "# Third answer"))
    await Promise.resolve()
    button("Previous answer").click()
  })
  expect(container.querySelector("h1")?.textContent).toBe("Second answer")
  await act(async () => button("Next answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("Third answer")
})

it("ignores a pending read when work resumes and after switching sessions", async () => {
  let resolveOld!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve
    }),
  )
  await render()
  await render({ ...tab, activity: "thinking" })
  await act(async () => resolveOld(transcript(tab.sessionPath!, "# Stale answer")))
  expect(container.querySelector(".completed-answers")).toBeNull()

  let resolveInactive!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveInactive = resolve
    }),
  )
  await render()
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript("/tmp/b.jsonl", "# Other session"))
  await render({ ...tab, sessionPath: "/tmp/b.jsonl" })
  await act(async () => resolveInactive(transcript(tab.sessionPath!, "# Late old session")))
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
  await act(async () => button("Show answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("Other session")
  expect(container.textContent).not.toContain("Late old session")
})

it.each(["en", "ru"] as const)(
  "jumps directly to the latest loaded answer in %s without reading or changing the draft",
  async (lang) => {
    const value = transcript(tab.sessionPath!, "# First", "# Second", "# Third", "# Fourth")
    vi.mocked(readSessionAnswers).mockResolvedValue(value)
    await render(tab, true, lang)
    for (let index = 0; index < 3; index++) {
      await act(async () => button(t(lang, "completedAnswerPrevious")).click())
    }
    expect(container.querySelector("h1")?.textContent).toBe("First")
    const latest = button(t(lang, "completedAnswerLatest"))
    latest.focus()
    await act(async () => latest.click())
    expect(container.querySelector("h1")?.textContent).toBe("Fourth")
    expect(container.querySelector("nav")?.textContent).toContain("4 / 4")
    expect(button(t(lang, "completedAnswerNext")).disabled).toBe(true)
    expect(document.activeElement).toBe(latest)
    expect(container.querySelector("input")?.value).toBe("Unsent draft")
    expect(readSessionAnswers).toHaveBeenCalledExactlyOnceWith(tab.sessionPath)
    expect(value.entries.map((entry) => entry.text)).toEqual([
      "# First",
      "# Second",
      "# Third",
      "# Fourth",
    ])
    expect(onError).not.toHaveBeenCalled()
  },
)

it.each([false, true])(
  "expands the latest loaded answer from a collapsed panel (older=%s)",
  async (older) => {
    vi.mocked(readSessionAnswers).mockResolvedValue(
      transcript(tab.sessionPath!, "# First", "# Last"),
    )
    await render()
    if (older) {
      await act(async () => button("Previous answer").click())
      await act(async () => button("Collapse answer").click())
    }
    expect(container.querySelector<HTMLElement>(".completed-answer-body")?.hidden).toBe(true)
    await act(async () => button("Latest loaded answer").click())
    expect(container.querySelector<HTMLElement>(".completed-answer-body")?.hidden).toBe(false)
    expect(container.querySelector("h1")?.textContent).toBe("Last")
    await act(async () => {
      button("Latest loaded answer").click()
      button("Latest loaded answer").click()
    })
    expect(container.querySelector("h1")?.textContent).toBe("Last")
    expect(readSessionAnswers).toHaveBeenCalledTimes(1)
  },
)

it.each([0, 1])("does not add a latest-answer action for %s loaded answers", async (count) => {
  vi.mocked(readSessionAnswers).mockResolvedValue(
    transcript(tab.sessionPath!, ...Array.from({ length: count }, () => "# Only")),
  )
  await render()
  expect(container.textContent).not.toContain("Latest loaded answer")
  if (count) {
    expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
    await act(async () => button("Show answer").click())
  }
  expect(container.querySelector("h1")?.textContent).toBe(count ? "Only" : undefined)
})

it("jumps in the latest committed snapshot when refresh and navigation are batched", async () => {
  const path = tab.sessionPath!
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript(path, "# First", "# Second"))
  await render()
  await act(async () => button("Previous answer").click())
  let resolveRefresh!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRefresh = resolve
    }),
  )
  await render({ ...tab, completedResponseVersion: 1 })
  await act(async () => {
    resolveRefresh(transcript(path, "# First", "# Second", "# Third"))
    await Promise.resolve()
    button("Previous answer").click()
    button("Latest loaded answer").click()
  })
  expect(container.querySelector("h1")?.textContent).toBe("Third")
  expect(container.querySelector("nav")?.textContent).toContain("3 / 3")
  expect(readSessionAnswers).toHaveBeenCalledTimes(2)
})

it("uses retained loaded answers after a failed refresh without hiding the warning or retrying", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(
    transcript(tab.sessionPath!, "# First", "# Last"),
  )
  await render()
  await act(async () => button("Previous answer").click())
  vi.mocked(readSessionAnswers).mockRejectedValueOnce(new Error("Synthetic read failed"))
  await render({ ...tab, completedResponseVersion: 1 })
  expect(container.querySelector("h1")?.textContent).toBe("First")
  await act(async () => button("Latest loaded answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("Last")
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Synthetic read failed")
  expect(readSessionAnswers).toHaveBeenCalledTimes(2)
})

it("leaves IME-marked keys alone in an answer link menu before a normal action", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(
    transcript(tab.sessionPath!, "[Synthetic file](local://synthetic.txt)"),
  )
  vi.mocked(openContentLink).mockResolvedValue(undefined)
  await render()
  await act(async () => button("Show answer").click())
  const link = container.querySelector<HTMLAnchorElement>('a[href="local://synthetic.txt"]')!
  window.getSelection()!.removeAllRanges()
  act(() => {
    link.focus()
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  })
  const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  expect(item).not.toBeNull()
  for (const target of [link, item]) {
    act(() => target.focus())
    for (const key of ["Escape", "Tab", "ArrowDown", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      })
      act(() => target.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(target)
      expect(document.querySelector('[role="menu"]')).not.toBeNull()
      expect(openContentLink).not.toHaveBeenCalled()
    }
  }
  await act(async () => item.click())
  expect(openContentLink).toHaveBeenCalledExactlyOnceWith(
    "local://synthetic.txt",
    tab.sessionPath,
    "open",
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(link)
})

it("keeps drafts and answer navigation usable after a Markdown failure", async () => {
  const source = "> ".repeat(8000) + "synthetic answer"
  vi.mocked(readSessionAnswers).mockResolvedValue(
    transcript(tab.sessionPath!, "# Earlier answer", source),
  )
  await render()
  await act(async () => button("Show answer").click())
  expect(container.querySelector(".markdown-source")?.textContent).toBe(source)
  expect(container.textContent).toContain(t("en", "markdownFormattingFailed"))
  const input = container.querySelector("input")!
  input.focus()
  expect(input.value).toBe("Unsent draft")
  await act(async () => button("Previous answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("Earlier answer")
  expect(container.textContent).not.toContain(t("en", "markdownFormattingFailed"))
  await act(async () => button("Latest loaded answer").click())
  expect(container.querySelector(".markdown-source")?.textContent).toBe(source)
  await act(async () => button("Collapse answer").click())
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
  expect(container.querySelector("input")).toBe(input)
  expect(input.value).toBe("Unsent draft")
  expect(readSessionAnswers).toHaveBeenCalledTimes(1)
  expect(onError).not.toHaveBeenCalled()
})

function pendingClipboard() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it.each([
  ["copyMessage", "resolve"],
  ["copyMessage", "reject"],
  ["copyMarkdown", "resolve"],
  ["copyMarkdown", "reject"],
] as const)("isolates pending answer copy %s from navigation and late %s", async (key, outcome) => {
  const source = "**Same synthetic answer**"
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, source, source))
  const old = pendingClipboard()
  const current = pendingClipboard()
  vi.mocked(writeText).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  await render()
  await act(async () => button("Show answer").click())
  const label = t("en", key)
  await act(async () => button(label).click())
  expect(button(label).disabled).toBe(true)
  await act(async () => button("Previous answer").click())
  expect(container.querySelector("nav")?.textContent).toContain("1 / 2")
  // Retain all observations even on baseline so the stale settlement is checked too.
  const independentlyEnabled = !button(label).disabled
  const navigationFeedback = button(label).textContent
  await act(async () => button(label).click())
  const independentCalls = vi.mocked(writeText).mock.calls.length
  await act(async () => {
    if (outcome === "resolve") old.resolve()
    else old.reject(new Error("Synthetic old clipboard failure"))
  })
  const lateFeedback = button(label).textContent
  const lateDisabled = button(label).disabled
  const lateErrors = onError.mock.calls.length
  await act(async () => current.resolve())
  expect.soft(independentlyEnabled).toBe(true)
  expect.soft(navigationFeedback).toBe(label)
  expect.soft(independentCalls).toBe(2)
  expect.soft(lateFeedback).toBe(t("en", "copying"))
  expect.soft(lateDisabled).toBe(true)
  expect.soft(lateErrors).toBe(0)
  expect.soft(button(label).textContent).toBe(t("en", "clipboardCopied"))
  expect.soft(button(label).disabled).toBe(false)
  expect
    .soft(vi.mocked(writeText).mock.calls)
    .toEqual([
      [key === "copyMessage" ? "Same synthetic answer" : source],
      [key === "copyMessage" ? "Same synthetic answer" : source],
    ])
})

it.each(["copyMessage", "copyMarkdown"] as const)(
  "resets pending answer copy %s when the selected text changes",
  async (key) => {
    vi.mocked(readSessionAnswers).mockResolvedValue(
      transcript(tab.sessionPath!, "Earlier", "Latest"),
    )
    const old = pendingClipboard()
    vi.mocked(writeText).mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined)
    await render()
    await act(async () => button("Show answer").click())
    const label = t("en", key)
    await act(async () => button(label).click())
    await act(async () => button("Previous answer").click())
    expect(button(label).disabled).toBe(false)
    await act(async () => old.reject(new Error("Synthetic old failure")))
    expect(onError).not.toHaveBeenCalled()
    expect(button(label).textContent).toBe(label)
    await act(async () => button(label).click())
    expect(writeText).toHaveBeenNthCalledWith(1, "Latest")
    expect(writeText).toHaveBeenNthCalledWith(2, "Earlier")
    expect(button(label).textContent).toBe(t("en", "clipboardCopied"))
  },
)

it.each(["copyMessage", "copyMarkdown"] as const)(
  "reports current answer copy %s rejection and permits retry",
  async (key) => {
    vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "Synthetic"))
    vi.mocked(writeText)
      .mockRejectedValueOnce(new Error("Synthetic current failure"))
      .mockResolvedValueOnce(undefined)
    await render()
    await act(async () => button("Show answer").click())
    const label = t("en", key)
    await act(async () => button(label).click())
    expect(onError).toHaveBeenCalledExactlyOnceWith("Error: Synthetic current failure")
    expect(button(label).disabled).toBe(false)
    expect(button(label).textContent).toBe(label)
    await act(async () => button(label).click())
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(button(label).textContent).toBe(t("en", "clipboardCopied"))
  },
)

it.each([
  ["copyMessage", false],
  ["copyMessage", true],
  ["copyMarkdown", false],
  ["copyMarkdown", true],
] as const)("handles refreshed answer copy %s entry clone=%s", async (key, clone) => {
  const value = transcript(tab.sessionPath!, "Synthetic refresh")
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(value)
  const old = pendingClipboard()
  vi.mocked(writeText).mockReturnValueOnce(old.promise)
  await render()
  await act(async () => button("Show answer").click())
  const label = t("en", key)
  await act(async () => button(label).click())
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(
    clone ? { ...value, entries: value.entries.map((entry) => ({ ...entry })) } : value,
  )
  await render({ ...tab, completedResponseVersion: 1 })
  expect(button(label).disabled).toBe(!clone)
  expect(button(label).textContent).toBe(clone ? label : t("en", "copying"))
  await act(async () => old.resolve())
  expect(button(label).textContent).toBe(clone ? label : t("en", "clipboardCopied"))
  expect(writeText).toHaveBeenCalledTimes(1)
  expect(onError).not.toHaveBeenCalled()
})

it.each([
  ["copyMessage", "resolve"],
  ["copyMessage", "reject"],
  ["copyMarkdown", "resolve"],
  ["copyMarkdown", "reject"],
] as const)("ignores unmounted answer copy %s late %s", async (key, outcome) => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "Synthetic unmount"))
  const old = pendingClipboard()
  vi.mocked(writeText).mockReturnValueOnce(old.promise)
  await render()
  await act(async () => button("Show answer").click())
  await act(async () => button(t("en", key)).click())
  await act(async () => root.render(null))
  await act(async () => {
    if (outcome === "resolve") old.resolve()
    else old.reject(new Error("Synthetic unmounted failure"))
  })
  expect(container.childElementCount).toBe(0)
  expect(onError).not.toHaveBeenCalled()
  expect(writeText).toHaveBeenCalledTimes(1)
})

it("defers unrequested markdown and retains revealed DOM through collapse", async () => {
  const source = "# Deferred\n\n**Synthetic** [file](./fixture.txt)\n\n```ts\nconst value = 1\n```"
  const lexer = vi.spyOn(marked, "lexer")
  try {
    vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, source))
    await render()
    const body = container.querySelector<HTMLElement>(".completed-answer-body")!
    expect(body.hidden).toBe(true)
    const toggle = button("Show answer")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(body)
    expect(body.tabIndex).toBe(0)
    expect(body.querySelectorAll("*")).toHaveLength(0)
    expect(lexer).not.toHaveBeenCalled()
    const input = container.querySelector("input")!
    input.focus()
    await act(async () => button("Show answer").click())
    expect(document.activeElement).toBe(input)
    const heading = body.querySelector("h1")!
    expect(heading.textContent).toBe("Deferred")
    expect(lexer.mock.calls.filter(([text]) => text === source)).toHaveLength(1)
    body.scrollTop = 42
    await act(async () => button("Collapse answer").click())
    expect(body.hidden).toBe(true)
    expect(body.querySelector("h1")).toBe(heading)
    expect(body.scrollTop).toBe(42)
    await act(async () => button("Show answer").click())
    expect(body.querySelector("h1")).toBe(heading)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(body)
    expect(lexer.mock.calls.filter(([text]) => text === source)).toHaveLength(1)
    expect(openContentLink).not.toHaveBeenCalled()
    let resolveLate!: (value: SessionTranscript) => void
    vi.mocked(readSessionAnswers).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLate = resolve
      }),
    )
    await render({ ...tab, completedResponseVersion: 1 })
    await act(async () => root.render(null))
    const parsesBeforeLate = lexer.mock.calls.length
    await act(async () => resolveLate(transcript(tab.sessionPath!, "# Unmounted late answer")))
    expect(container.children).toHaveLength(0)
    expect(lexer.mock.calls).toHaveLength(parsesBeforeLate)
  } finally {
    lexer.mockRestore()
  }
})

it("defers same-ID edits before reveal but updates requested content and resets new answers", async () => {
  const lexer = vi.spyOn(marked, "lexer")
  try {
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript(tab.sessionPath!, "# Original"))
    await render()
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(
      transcript(tab.sessionPath!, "# Edited before"),
    )
    await render({ ...tab, completedResponseVersion: 1 })
    expect(lexer).not.toHaveBeenCalled()
    expect(container.querySelector("h1")).toBeNull()
    await act(async () => button("Show answer").click())
    expect(container.querySelector("h1")?.textContent).toBe("Edited before")
    await act(async () => button("Collapse answer").click())
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(
      transcript(tab.sessionPath!, "# Edited after"),
    )
    await render({ ...tab, completedResponseVersion: 2 })
    expect(container.querySelector<HTMLElement>(".completed-answer-body")?.hidden).toBe(true)
    expect(container.querySelector("h1")?.textContent).toBe("Edited after")
    const input = container.querySelector("input")!
    input.focus()
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(
      transcript(tab.sessionPath!, "# Edited after", "# New latest"),
    )
    await render({ ...tab, completedResponseVersion: 3 })
    expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector("h1")).toBeNull()
    expect(lexer.mock.calls.some(([text]) => text === "# New latest")).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("Unsent draft")
    await act(async () => button("Previous answer").click())
    expect(container.querySelector("h1")?.textContent).toBe("Edited after")
    await act(async () => button("Latest loaded answer").click())
    expect(container.querySelector("h1")?.textContent).toBe("New latest")
  } finally {
    lexer.mockRestore()
  }
})

it("keeps unrequested content deferred across read error retry and busy transitions", async () => {
  const lexer = vi.spyOn(marked, "lexer")
  try {
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript(tab.sessionPath!, "# Initial"))
    await render()
    vi.mocked(readSessionAnswers).mockRejectedValueOnce(new Error("Synthetic retry error"))
    await render({ ...tab, completedResponseVersion: 1 })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic retry error",
    )
    expect(container.querySelector("h1")).toBeNull()
    expect(lexer).not.toHaveBeenCalled()
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript(tab.sessionPath!, "# Retried"))
    await act(async () => button("Reread file").click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(lexer).not.toHaveBeenCalled()
    await render({ ...tab, activity: "thinking", completedResponseVersion: 1 })
    expect(container.querySelector(".completed-answers")).toBeNull()
    vi.mocked(readSessionAnswers).mockResolvedValueOnce(
      transcript(tab.sessionPath!, "# After busy"),
    )
    await render({ ...tab, completedResponseVersion: 2 })
    expect(lexer).not.toHaveBeenCalled()
    await act(async () => button("Show answer").click())
    expect(container.querySelector("h1")?.textContent).toBe("After busy")
    expect(lexer.mock.calls.filter(([text]) => text === "# After busy")).toHaveLength(1)
  } finally {
    lexer.mockRestore()
  }
})

it("focuses the answer body on expand and returns focus to the terminal on collapse", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# Answer"))
  const pane = document.createElement("div")
  pane.className = "terminal-pane is-active"
  const terminalInput = document.createElement("textarea")
  terminalInput.className = "xterm-helper-textarea"
  pane.appendChild(terminalInput)
  document.body.appendChild(pane)

  await render(tab, true, "en", true)
  const show = button("Show answer")
  show.focus()
  await act(async () => show.click())
  const body = container.querySelector<HTMLElement>(".completed-answer-body")!
  expect(body.hidden).toBe(false)
  expect(document.activeElement).toBe(body)

  const hide = button("Collapse answer")
  hide.focus()
  await act(async () => hide.click())
  expect(body.hidden).toBe(true)
  expect(document.activeElement).toBe(terminalInput)
})

it("collapses an expanded answer on Escape and returns focus to the terminal", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# Answer"))
  const pane = document.createElement("div")
  pane.className = "terminal-pane is-active"
  const terminalInput = document.createElement("textarea")
  terminalInput.className = "xterm-helper-textarea"
  pane.appendChild(terminalInput)
  document.body.appendChild(pane)

  await render(tab, true, "en", true)
  const show = button("Show answer")
  show.focus()
  await act(async () => show.click())
  const body = container.querySelector<HTMLElement>(".completed-answer-body")!
  expect(document.activeElement).toBe(body)

  await act(async () => {
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
  expect(body.hidden).toBe(true)
  expect(document.activeElement).toBe(terminalInput)
})

it("moves focus with expand-fill off", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# Answer"))
  const pane = document.createElement("div")
  pane.className = "terminal-pane is-active"
  const terminalInput = document.createElement("textarea")
  terminalInput.className = "xterm-helper-textarea"
  pane.appendChild(terminalInput)
  document.body.appendChild(pane)

  await render(tab, true, "en", false)
  const show = button("Show answer")
  show.focus()
  await act(async () => show.click())
  const body = container.querySelector<HTMLElement>(".completed-answer-body")!
  expect(document.activeElement).toBe(body)
  expect(container.querySelector(".completed-answers")?.classList.contains("is-expanded")).toBe(
    false,
  )
  await act(async () => button("Collapse answer").click())
  expect(document.activeElement).toBe(terminalInput)
})

it("returns focus to the toggle when no active terminal input exists", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# Answer"))
  await render(tab, true, "en", true)
  const show = button("Show answer")
  show.focus()
  await act(async () => show.click())
  const body = container.querySelector<HTMLElement>(".completed-answer-body")!
  expect(document.activeElement).toBe(body)

  await act(async () => {
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
  const toggle = button("Show answer")
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement).toBe(toggle)
})

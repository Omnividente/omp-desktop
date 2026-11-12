/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { SessionDetails } from "./SessionDetails"
import type { SessionSummary } from "./types"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./api", () => ({ errorMessage: (error: unknown) => String(error) }))
const onError = vi.fn()

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const session: SessionSummary = {
  id: "synthetic-id",
  title: "Synthetic history",
  pinnedTitle: null,
  cwd: "/synthetic/project",
  projectKey: "project",
  filePath: "/synthetic/history.jsonl",
  parentSessionPath: "/synthetic/previous.jsonl",
  createdAt: "2026-11-05T10:23:45.123+04:00",
  updatedAt: 1,
  model: "synthetic/model:high",
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(writeText).mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function values() {
  return Array.from(container.querySelectorAll("dd"), (element) => element.textContent)
}

it("starts collapsed and exposes exact recorded fields after explicit expansion", () => {
  act(() => root.render(<SessionDetails session={session} lang="en" onError={onError} />))
  const details = container.querySelector("details")!
  const summary = container.querySelector("summary")!
  expect(details.open).toBe(false)
  expect(summary.textContent).toBe("Session details")
  act(() => summary.click())
  expect(details.open).toBe(true)
  expect(values()).toEqual([
    session.id,
    session.cwd,
    session.filePath,
    session.createdAt,
    session.model,
    session.parentSessionPath,
  ])
  expect(container.textContent).toContain("not current OMP state")
  expect(container.querySelector<HTMLElement>(".session-details-content")?.tabIndex).toBe(0)
  act(() => summary.click())
  expect(details.open).toBe(false)
})

it("labels absent optional values without guessing a date, model or parent", () => {
  act(() =>
    root.render(
      <SessionDetails
        session={{ ...session, createdAt: "", model: null, parentSessionPath: "  " }}
        lang="en"
        onError={onError}
      />,
    ),
  )
  expect(values().slice(3)).toEqual(["Not recorded", "Not recorded", "Not recorded"])
})

it("renders untrusted strings as plain selectable text without links or HTML", () => {
  const recorded = "<img src=x onerror=alert(1)>\n<script>bad()</script>"
  act(() =>
    root.render(
      <SessionDetails
        session={{ ...session, id: recorded, parentSessionPath: "https://synthetic.invalid" }}
        lang="en"
        onError={onError}
      />,
    ),
  )
  expect(values()[0]).toBe(recorded)
  expect(values().at(-1)).toBe("https://synthetic.invalid")
  expect(container.querySelector("a, img, script")).toBeNull()
})

it("updates an open snapshot and switches labels to Russian without retaining old values", () => {
  act(() => root.render(<SessionDetails session={session} lang="en" onError={onError} />))
  act(() => container.querySelector("summary")!.click())
  act(() =>
    root.render(
      <SessionDetails
        session={{ ...session, model: "synthetic/new", createdAt: "invalid" }}
        lang="ru"
        onError={onError}
      />,
    ),
  )
  expect(container.querySelector("details")?.open).toBe(true)
  expect(container.querySelector("summary")?.textContent).toBe("Сведения о сессии")
  expect(values()[3]).toBe("invalid")
  expect(values()[4]).toBe("synthetic/new")
  expect(container.textContent).not.toContain("synthetic/model:high")
})

it.each([
  ["en", " /synthetic/проект e\u0301/$&/history.jsonl ", "Copy history file path"],
  ["zh", " /synthetic/路径/$&/history.jsonl ", "复制历史文件路径"],
  ["ru", "C:\\synthetic\\проект\\history.jsonl", "Скопировать путь файла истории"],
] as const)(
  "copies only the exact loaded file path after an explicit %s action",
  async (lang, filePath, label) => {
    act(() =>
      root.render(
        <SessionDetails session={{ ...session, filePath }} lang={lang} onError={onError} />,
      ),
    )
    expect(writeText).not.toHaveBeenCalled()
    act(() => container.querySelector("summary")!.click())
    expect(writeText).not.toHaveBeenCalled()
    const button = container.querySelector<HTMLButtonElement>("button")!
    expect(button.getAttribute("aria-label")).toBe(label)
    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(filePath)
    expect(button.textContent).toBe(
      lang === "ru" ? "Скопировано" : lang === "zh" ? "已复制" : "Copied",
    )
    expect(values()[2]).toBe(filePath)
    expect(onError).not.toHaveBeenCalled()
  },
)

it.each(["", " \t\n "])("offers no file copy action for an unrecorded path %j", (filePath) => {
  act(() =>
    root.render(<SessionDetails session={{ ...session, filePath }} lang="en" onError={onError} />),
  )
  act(() => container.querySelector("summary")!.click())
  expect(values()[2]).toBe("Not recorded")
  expect(container.querySelector("button")).toBeNull()
  expect(writeText).not.toHaveBeenCalled()
})

it("blocks repeated copies while pending, reports rejection and allows an explicit retry", async () => {
  let reject!: (error: Error) => void
  vi.mocked(writeText).mockReturnValueOnce(new Promise((_, fail) => (reject = fail)))
  act(() => root.render(<SessionDetails session={session} lang="en" onError={onError} />))
  act(() => container.querySelector("summary")!.click())
  const button = container.querySelector<HTMLButtonElement>("button")!
  act(() => {
    button.click()
    button.click()
  })
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe("Copying…")
  expect(writeText).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error("Synthetic clipboard refusal")))
  expect(onError).toHaveBeenCalledExactlyOnceWith("Error: Synthetic clipboard refusal")
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe("Copy history file path")
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(button.textContent).toBe("Copied")
})

it.each(["resolve", "reject"] as const)(
  "ignores a late %s after the loaded snapshot changes",
  async (outcome) => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    vi.mocked(writeText).mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
      }),
    )
    act(() => root.render(<SessionDetails session={session} lang="en" onError={onError} />))
    act(() => container.querySelector("summary")!.click())
    act(() => container.querySelector<HTMLButtonElement>("button")!.click())
    // The same pathname may now belong to a freshly loaded snapshot.
    act(() =>
      root.render(
        <SessionDetails session={{ ...session, id: "new-snapshot" }} lang="en" onError={onError} />,
      ),
    )
    await act(async () => {
      if (outcome === "resolve") resolve()
      else reject(new Error("Synthetic late refusal"))
    })
    expect(container.querySelector("button")?.textContent).toBe("Copy history file path")
    expect(onError).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledTimes(1)
  },
)

it.each(["resolve", "reject"] as const)(
  "ignores a late %s after the details are unmounted for close or reread",
  async (outcome) => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    vi.mocked(writeText).mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
      }),
    )
    act(() => root.render(<SessionDetails session={session} lang="en" onError={onError} />))
    act(() => container.querySelector("summary")!.click())
    act(() => container.querySelector<HTMLButtonElement>("button")!.click())
    act(() => root.render(null))
    await act(async () => {
      if (outcome === "resolve") resolve()
      else reject(new Error("Synthetic late refusal"))
    })
    expect(container.textContent).toBe("")
    expect(onError).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledExactlyOnceWith(session.filePath)
  },
)

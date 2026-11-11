/** @vitest-environment jsdom */
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window"
import type { TerminalTab } from "./types"
import { useWindowActivity } from "./useWindowActivity"

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
  ProgressBarStatus: { None: "none", Indeterminate: "indeterminate" },
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function tab(id: string, activity: TerminalTab["activity"] = "idle"): TerminalTab {
  return {
    id,
    label: `Synthetic ${id}`,
    pinnedTitle: null,
    cwd: "/synthetic/project",
    processId: 1,
    sessionId: id,
    sessionPath: `/synthetic/${id}.jsonl`,
    status: "running",
    activity,
    exitCode: null,
    success: null,
    kind: "agent",
    switching: false,
    switchRecovery: null,
    primaryProviderPinned: false,
    primaryProviderPinPending: false,
  }
}

function Activity({ tabs, active }: { tabs: TerminalTab[]; active: string | null }) {
  useWindowActivity(tabs, active)
  return null
}

let container: HTMLDivElement
let root: Root
let originalTitle: string
const setProgressBar = vi.fn()
const statuses = () => setProgressBar.mock.calls.map(([options]) => options.status)

async function render(tabs: TerminalTab[], active: string | null = null, strict = false) {
  await act(async () => {
    const content = <Activity tabs={tabs} active={active} />
    root.render(strict ? <StrictMode>{content}</StrictMode> : content)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  originalTitle = document.title
  setProgressBar.mockResolvedValue(undefined)
  vi.mocked(getCurrentWindow).mockReturnValue({
    setProgressBar,
  } as unknown as ReturnType<typeof getCurrentWindow>)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.title = originalTitle
})

it("keeps the active title without repeating native progress for metadata updates", async () => {
  await render([tab("a")], "a")
  for (let index = 0; index < 100; index++) {
    await render(
      [{ ...tab("a"), label: `Synthetic ${index}`, currentModel: `model-${index}` }],
      "a",
    )
  }
  expect(document.title).toBe("Synthetic 99 — OMP Desktop")
  expect(statuses()).toEqual([ProgressBarStatus.None])
})

it("updates titles and counts without resending an unchanged indeterminate status", async () => {
  await render([tab("a", "thinking"), tab("b")], "a")
  expect(document.title).toBe("[Thinking...] Synthetic a — OMP Desktop")
  await render([tab("a", "thinking"), tab("b")], "b")
  expect(document.title).toBe("[Thinking ×1] OMP Desktop")
  await render([tab("a", "thinking"), tab("b", "thinking")], null)
  expect(document.title).toBe("[Thinking ×2] OMP Desktop")
  await render([tab("b", "thinking")], "missing")
  expect(document.title).toBe("[Thinking ×1] OMP Desktop")
  expect(statuses()).toEqual([ProgressBarStatus.Indeterminate])
})

it("sends every thinking boundary including exit and the last tab closing", async () => {
  await render([], null)
  await render([tab("a", "thinking")], "a")
  await render([{ ...tab("a"), status: "exited" }], "a")
  await render([{ ...tab("u", "thinking"), kind: "utility" }], "u")
  await render([], null)
  expect(document.title).toBe("OMP Desktop")
  expect(statuses()).toEqual([
    ProgressBarStatus.None,
    ProgressBarStatus.Indeterminate,
    ProgressBarStatus.None,
    ProgressBarStatus.Indeterminate,
    ProgressBarStatus.None,
  ])
})

it("does not count error or fallback activity as thinking", async () => {
  await render([tab("a", "error"), tab("b", "fallback")], "a")
  await render([tab("b", "fallback"), tab("a", "error")], "b")
  expect(document.title).toBe("Synthetic b — OMP Desktop")
  expect(statuses()).toEqual([ProgressBarStatus.None])
})

it.each(["window", "call", "promise"])(
  "retries a native %s failure on the next same-state update without a timer",
  async (failure) => {
    const error = new Error("Synthetic native failure")
    if (failure === "window")
      vi.mocked(getCurrentWindow).mockImplementationOnce(() => {
        throw error
      })
    else if (failure === "call")
      setProgressBar.mockImplementationOnce(() => {
        throw error
      })
    else setProgressBar.mockRejectedValueOnce(error)
    await render([tab("a")], "a")
    expect(document.title).toBe("Synthetic a — OMP Desktop")
    const attempts = vi.mocked(getCurrentWindow).mock.calls.length
    await act(async () => {})
    expect(getCurrentWindow).toHaveBeenCalledTimes(attempts)
    await render([{ ...tab("a"), label: "Renamed" }], "a")
    expect(document.title).toBe("Renamed — OMP Desktop")
    expect(getCurrentWindow).toHaveBeenCalledTimes(attempts + 1)
    expect(statuses().at(-1)).toBe(ProgressBarStatus.None)
    await render([tab("a")], "a")
    expect(getCurrentWindow).toHaveBeenCalledTimes(attempts + 1)
  },
)

it("initializes each new mount without duplicating StrictMode effect replay", async () => {
  await render([tab("a")], "a", true)
  expect(statuses()).toEqual([ProgressBarStatus.None])
  await render([{ ...tab("a"), label: "Renamed" }], "a", true)
  expect(document.title).toBe("Renamed — OMP Desktop")
  expect(setProgressBar).toHaveBeenCalledTimes(1)
  await act(async () => root.render(null))
  await render([tab("a")], "a", true)
  expect(setProgressBar).toHaveBeenCalledTimes(2)
})

it("deduplicates pending status and ignores an older request failure", async () => {
  let rejectOld!: (reason: Error) => void
  setProgressBar.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject
      }),
  )
  await render([tab("a", "thinking")], "a")
  await render([{ ...tab("a", "thinking"), label: "Renamed" }], "a")
  expect(setProgressBar).toHaveBeenCalledTimes(1)
  await render([tab("a")], "a")
  expect(statuses()).toEqual([ProgressBarStatus.Indeterminate, ProgressBarStatus.None])
  await act(async () => rejectOld(new Error("Synthetic late failure")))
  await render([{ ...tab("a"), label: "Later" }], "a")
  expect(setProgressBar).toHaveBeenCalledTimes(2)
  expect(document.title).toBe("Later — OMP Desktop")
})

it("retries a rejected thinking status on a later same-state update", async () => {
  setProgressBar.mockRejectedValueOnce(new Error("Synthetic transient failure"))
  await render([tab("a", "thinking")], "a")
  await render([{ ...tab("a", "thinking"), label: "Retry" }], "a")
  expect(statuses()).toEqual([ProgressBarStatus.Indeterminate, ProgressBarStatus.Indeterminate])
  await render([tab("a", "thinking")], "a")
  expect(setProgressBar).toHaveBeenCalledTimes(2)
})

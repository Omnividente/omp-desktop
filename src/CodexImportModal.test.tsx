/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CodexImportModal } from "./CodexImportModal"
import type { CodexSessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const session: CodexSessionSummary = {
  id: "synthetic",
  title: "Synthetic import",
  cwd: "/synthetic/project",
  filePath: "/synthetic/session.jsonl",
  createdAt: "2026-01-01",
  updatedAt: 1,
  model: null,
  preview: "",
}
let root: Root
let container: HTMLDivElement
let opener: HTMLButtonElement

beforeEach(() => {
  opener = document.createElement("button")
  opener.textContent = "Open import"
  container = document.createElement("div")
  document.body.append(opener, container)
  root = createRoot(container)
  opener.focus()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  opener.remove()
})

function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  act(() => target.dispatchEvent(event))
  return event
}

function dialog() {
  return container.querySelector<HTMLElement>("[role=dialog]")!
}

function closeButton() {
  return dialog().querySelector<HTMLButtonElement>("header button")!
}

it.each([100, 500, 10000])(
  "keeps %i failed import rows navigable with persistent reasons outside virtual rows",
  async (count) => {
    const sessions = Array.from({ length: count }, (_, index): CodexSessionSummary => ({
      ...session,
      id: `geometry-${index}`,
      filePath: `/synthetic/geometry-${index}.jsonl`,
      title: `Geometry ${index}`,
    }))
    const observers = new Set<() => void>()
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const viewportHeight = 480
    const viewportWidth = 700
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame))
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        private targets = new Set<Element>()
        private notify: () => void
        constructor(callback: ResizeObserverCallback) {
          this.notify = () =>
            callback(
              Array.from(this.targets, (target) => ({ target }) as ResizeObserverEntry),
              this,
            )
          observers.add(this.notify)
        }
        observe(target: Element) {
          this.targets.add(target)
        }
        unobserve(target: Element) {
          this.targets.delete(target)
        }
        disconnect() {
          this.targets.clear()
          observers.delete(this.notify)
        }
      },
    )
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight)
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth)
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      const contents = this.querySelector<HTMLElement>(".codex-list-contents")
      return contents ? Number.parseFloat(contents.style.height) : viewportHeight
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const list = this.closest<HTMLElement>(".codex-list")
      const top = this.classList.contains("codex-item")
        ? Number.parseFloat(this.style.top) - (list?.scrollTop ?? 0)
        : 0
      const height = this.classList.contains("codex-item")
        ? this.querySelector(".codex-import-error")
          ? 360
          : 86
        : viewportHeight
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: viewportWidth,
        bottom: top + height,
        width: viewportWidth,
        height,
        toJSON: () => ({}),
      }
    })
    async function flushFrames() {
      await act(async () => {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(0)
      })
    }

    const selected = Object.fromEntries(sessions.map((s) => [s.filePath, true]))
    const render = (failures: Record<string, string>) =>
      root.render(
        <CodexImportModal
          language="en"
          loading={false}
          importing={false}
          mode="skip"
          sessions={sessions}
          selected={selected}
          failures={failures}
          onSelectedChange={() => undefined}
          onClose={() => root.render(null)}
          onImport={() => undefined}
          onModeChange={() => undefined}
        />,
      )
    const row = (index: number) =>
      container.querySelector<HTMLElement>(`[data-virtual-index="${index}"]`)!
    const assertSeparated = () => {
      const rows = [...container.querySelectorAll<HTMLElement>(".codex-item")]
      for (let i = 1; i < rows.length; i++) {
        expect(Number.parseFloat(rows[i].style.top)).toBeGreaterThanOrEqual(
          Number.parseFloat(rows[i - 1].style.top) + rows[i - 1].getBoundingClientRect().height + 8,
        )
      }
    }
    try {
      act(() => render({}))
      expect(Number.parseFloat(row(1).style.top)).toBe(94)
      const failures = Object.fromEntries(
        sessions.map((s) => [
          s.filePath,
          "Synthetic permission denied while reading session.\n".repeat(40).slice(0, 2048),
        ]),
      )
      act(() => render(failures))
      expect(Number.parseFloat(row(1).style.top)).toBe(94)
      expect(container.querySelectorAll(".codex-import-failures li")).toHaveLength(20)
      expect(container.querySelectorAll(".codex-item").length).toBeLessThan(30)
      expect(container.querySelectorAll(".codex-item .codex-import-error")).toHaveLength(0)
      expect(container.querySelectorAll(".codex-import-failures *").length).toBeLessThanOrEqual(90)
      const report = container.querySelector<HTMLElement>(".codex-import-failures")!
      expect(report.tabIndex).toBe(0)
      expect(report.getAttribute("aria-label")).toBe("Import failure details")
      act(() => report.focus())
      expect(press(report, "PageDown").defaultPrevented).toBe(false)
      expect(press(report, "ArrowDown").defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(report)
      const nextPage = report.querySelector<HTMLButtonElement>("nav button:last-child")!
      act(() => {
        nextPage.focus()
        nextPage.click()
      })
      expect(document.activeElement).toBe(nextPage)
      expect(report.querySelector("[role=status]")?.textContent).toBe(`Failures 21–40 of ${count}`)
      expect(report.querySelector("li small")?.textContent).toBe(sessions[20].filePath)

      assertSeparated()
      const firstInput = row(0).querySelector<HTMLInputElement>("input")!
      act(() => firstInput.focus())
      press(firstInput, "End")
      await flushFrames()
      expect(
        row(count - 1),
        "last failure row must remain mounted after End and remeasurement",
      ).not.toBeNull()
      const lastInput = row(count - 1).querySelector<HTMLInputElement>("input")!
      expect(document.activeElement).toBe(lastInput)
      expect(report.querySelector("[role=status]")?.textContent).toBe(
        `Failures ${count - 19}–${count} of ${count}`,
      )
      expect(report.querySelector("li:last-child small")?.textContent).toBe(
        sessions[count - 1].filePath,
      )
      act(() => {
        nextPage.focus()
        nextPage.click()
      })
      expect(document.activeElement).toBe(nextPage)
      expect(nextPage.getAttribute("aria-disabled")).toBe("true")

      expect(
        document.getElementById(lastInput.getAttribute("aria-describedby")!)?.textContent,
      ).toBe(failures[sessions[count - 1].filePath])
      assertSeparated()
      press(lastInput, "Home")
      await flushFrames()
      expect(document.activeElement).toBe(row(0).querySelector("input"))
      expect(report.querySelector("[role=status]")?.textContent).toBe(`Failures 1–20 of ${count}`)
      act(() => nextPage.click())
      act(() =>
        render(
          Object.fromEntries(sessions.slice(0, 3).map((s) => [s.filePath, "Replacement reason"])),
        ),
      )
      expect(report.querySelector("[role=status]")?.textContent).toBe("Failures 1–3 of 3")
      expect(report.querySelectorAll("li")).toHaveLength(3)
      expect(report.textContent).not.toContain("Synthetic permission denied")
      for (const input of container.querySelectorAll<HTMLInputElement>(
        ".codex-item input[aria-describedby]",
      )) {
        expect(
          document
            .getElementById(input.getAttribute("aria-describedby")!)
            ?.getAttribute("aria-hidden"),
        ).toBe("true")
        expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
          "Replacement reason",
        )
      }

      act(() => render({}))
      expect(Number.parseFloat(row(1).style.top)).toBe(94)
      expect(container.querySelector(".codex-import-error")).toBeNull()
      expect(container.querySelector("[aria-describedby^='codex-import-description']")).toBeNull()
      assertSeparated()
      const importButton = container.querySelector<HTMLElement>(".settings-actions .primary")!
      act(() => importButton.focus())
      expect(press(importButton, "Tab").defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(closeButton())
      expect(press(closeButton(), "Tab", { shiftKey: true }).defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(importButton)
      act(() => closeButton().click())
      expect(dialog()).toBeNull()
      expect(observers.size).toBe(0)
      expect(frames.size).toBe(0)
    } finally {
      act(() => root.render(null))
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)

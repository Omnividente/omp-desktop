/** @vitest-environment jsdom */
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CodexImportModal } from "./CodexImportModal"
import { t, type Lang } from "./i18n"
import type { CodexSessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const sessions: CodexSessionSummary[] = ["Migration first", "Other task", "Migration last"].map(
  (title, index) => ({
    id: `synthetic-${index}`,
    title,
    cwd: "/synthetic/project",
    filePath: `/synthetic/${index}.jsonl`,
    createdAt: "2026-01-01",
    updatedAt: 1,
    model: null,
    preview: "",
  }),
)
const onClose = vi.fn()
const onImport = vi.fn()
const onSelectedChange = vi.fn()
let root: Root
let container: HTMLDivElement

function Fixture({
  items = sessions,
  importing = false,
  loading = false,
  language = "en",
  failures = {},
  initialSelected = {},
}: {
  items?: CodexSessionSummary[]
  importing?: boolean
  loading?: boolean
  language?: Lang
  failures?: Record<string, string>
  initialSelected?: Record<string, boolean>
}) {
  const [selected, setSelected] = useState(initialSelected)
  return (
    <CodexImportModal
      language={language}
      loading={loading}
      importing={importing}
      mode="copy"
      sessions={items}
      selected={selected}
      failures={failures}
      onSelectedChange={(next) => {
        onSelectedChange(next)
        setSelected(next)
      }}
      onClose={onClose}
      onImport={() => onImport(items.filter((session) => selected[session.filePath]))}
      onModeChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function search() {
  return container.querySelector<HTMLInputElement>("input[type=search]")!
}

function enterQuery(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!
}

function rows() {
  return [...container.querySelectorAll<HTMLInputElement>(".codex-item input")]
}

function press(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  act(() => target.dispatchEvent(event))
  return event
}

it("retains hidden selections and discloses them before import", () => {
  act(() => root.render(<Fixture initialSelected={{ [sessions[1].filePath]: true }} />))
  enterQuery("migration")
  expect(rows()).toHaveLength(2)
  expect(container.textContent).toContain("Matching: 2 of 3.")
  expect(container.textContent).toContain("Selected: 1, hidden by search: 1.")
  expect(onSelectedChange).not.toHaveBeenCalled()
  act(() => button("Select matching").click())
  expect(container.textContent).toContain("Selected: 3, hidden by search: 1.")
  act(() => button("Import selected").click())
  expect(onImport).toHaveBeenCalledWith(sessions)
  act(() => button("Clear search").click())
  expect(search().value).toBe("")
  expect(document.activeElement).toBe(search())
  expect(rows().map((input) => input.checked)).toEqual([true, true, true])
})

it("selects every matching session, including rows outside the virtual window", () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    ...sessions[0],
    id: `large-${index}`,
    filePath: `/synthetic/large-${index}.jsonl`,
    title: index % 2 === 0 ? "Migration task" : "Other task",
  }))
  act(() => root.render(<Fixture items={items} />))
  enterQuery("migration")
  expect(rows().length).toBeLessThan(60)
  act(() => button("Select matching").click())
  expect(Object.keys(onSelectedChange.mock.lastCall![0])).toHaveLength(60)
  act(() => button("Import selected").click())
  expect(onImport).toHaveBeenCalledWith(items.filter((_, index) => index % 2 === 0))
})

it("keeps hidden selections actionable at zero matches and clears the entire selection", () => {
  act(() => root.render(<Fixture initialSelected={{ [sessions[1].filePath]: true }} />))
  enterQuery("no such session")
  expect(rows()).toHaveLength(0)
  expect(container.textContent).toContain("No sessions match the search")
  expect(button("Select matching").disabled).toBe(true)
  expect(button("Import selected").disabled).toBe(false)
  act(() => button("Clear selection").click())
  expect(onSelectedChange).toHaveBeenLastCalledWith({})
  expect(button("Import selected").disabled).toBe(true)
  expect(search().value).toBe("no such session")
})

it("locks search and all selection actions while the batch is pending", () => {
  act(() => root.render(<Fixture initialSelected={{ [sessions[0].filePath]: true }} />))
  enterQuery("migration")
  act(() => root.render(<Fixture importing />))
  expect(search().disabled).toBe(true)
  expect(button("Clear search").disabled).toBe(true)
  expect(button("Select matching").disabled).toBe(true)
  expect(button("Clear selection").disabled).toBe(true)
  expect(rows().every((input) => input.disabled)).toBe(true)
  act(() => {
    button("Select matching").click()
    button("Clear selection").click()
    button("Clear search").click()
    rows()[0].click()
  })
  expect(onSelectedChange).not.toHaveBeenCalled()
  expect(search().value).toBe("migration")
  act(() => root.render(<Fixture />))
  expect(search().disabled).toBe(false)
  expect(button("Clear selection").disabled).toBe(false)
})

it("keeps failure details global and maps filtered focus to the original failure page", () => {
  const items = Array.from({ length: 22 }, (_, index) => ({
    ...sessions[0],
    id: `failure-${index}`,
    filePath: `/synthetic/failure-${index}.jsonl`,
    title: index === 21 ? "Last matching session" : "Other session",
  }))
  const failures = Object.fromEntries(
    items.map((session, index) => [session.filePath, `Error ${index}`]),
  )
  act(() => root.render(<Fixture items={items} failures={failures} />))
  enterQuery("last matching")
  expect(rows()).toHaveLength(1)
  expect(container.querySelectorAll(".codex-import-failures li")).toHaveLength(20)
  act(() => rows()[0].focus())
  const report = container.querySelector(".codex-import-failures")!
  expect(report.querySelectorAll("li")).toHaveLength(2)
  expect(report.textContent).toContain("Error 21")
  const description = document.getElementById(rows()[0].getAttribute("aria-describedby")!)!
  expect(description.textContent).toBe("Error 21")
})

it("uses filtered order for Home, End and arrow navigation without changing selection", () => {
  act(() => root.render(<Fixture />))
  enterQuery("migration")
  act(() => rows()[0].focus())
  press(rows()[0], "End")
  expect(document.activeElement).toBe(rows()[1])
  press(rows()[1], "ArrowUp")
  expect(document.activeElement).toBe(rows()[0])
  press(rows()[0], "ArrowDown")
  expect(document.activeElement).toBe(rows()[1])
  press(rows()[1], "Home")
  expect(document.activeElement).toBe(rows()[0])
  expect(onSelectedChange).not.toHaveBeenCalled()
})

it("resets list scroll for a changed query but not a selection update", () => {
  act(() => root.render(<Fixture />))
  const list = container.querySelector<HTMLDivElement>(".codex-list")!
  list.scrollTop = 200
  enterQuery("migration")
  expect(list.scrollTop).toBe(0)
  list.scrollTop = 40
  act(() => rows()[0].click())
  expect(list.scrollTop).toBe(40)
  act(() => button("Clear search").click())
  expect(list.scrollTop).toBe(0)
})

it("leaves composition Escape untouched and permits ordinary dialog dismissal", () => {
  act(() => root.render(<Fixture />))
  enterQuery("migration")
  expect(press(search(), "Escape", { isComposing: true }).defaultPrevented).toBe(false)
  expect(press(search(), "Escape", { keyCode: 229 }).defaultPrevented).toBe(false)
  expect(onClose).not.toHaveBeenCalled()
  expect(search().value).toBe("migration")
  expect(press(search(), "Escape").defaultPrevented).toBe(true)
  expect(onClose).toHaveBeenCalledOnce()
})

it("retains the query and selection across metadata and language updates", () => {
  act(() => root.render(<Fixture initialSelected={{ [sessions[1].filePath]: true }} />))
  enterQuery("migration")
  const items = [...sessions, { ...sessions[0], id: "new", filePath: "/synthetic/new.jsonl" }]
  act(() => root.render(<Fixture items={items} language="ru" />))
  expect(search().value).toBe("migration")
  expect(rows()).toHaveLength(3)
  expect(container.textContent).toContain("Найдено: 3 из 4.")
  expect(container.textContent).toContain("Выбрано: 1, скрыто поиском: 1.")
  expect(button(t("ru", "codexSelectMatching"))).toBeDefined()
  expect(onSelectedChange).not.toHaveBeenCalled()
})

it("preserves loading and empty-list explanations and disables bulk selection", () => {
  act(() => root.render(<Fixture items={[]} loading />))
  expect(container.textContent).toContain(t("en", "loading"))
  expect(button("Select all").disabled).toBe(true)
  act(() => root.render(<Fixture items={[]} />))
  expect(container.textContent).toContain(t("en", "noCodexSessions"))
  expect(button("Select all").disabled).toBe(true)
  expect(button("Clear selection").disabled).toBe(true)
})

it("starts a newly mounted dialog with an empty query", () => {
  act(() => root.render(<Fixture key="first" />))
  enterQuery("migration")
  act(() => root.render(<Fixture key="second" />))
  expect(search().value).toBe("")
  expect(rows()).toHaveLength(3)
})

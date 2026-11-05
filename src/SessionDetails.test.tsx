/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { SessionDetails } from "./SessionDetails"
import type { SessionSummary } from "./types"

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
  act(() => root.render(<SessionDetails session={session} lang="en" />))
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
      />,
    ),
  )
  expect(values()[0]).toBe(recorded)
  expect(values().at(-1)).toBe("https://synthetic.invalid")
  expect(container.querySelector("a, img, script, button")).toBeNull()
})

it("updates an open snapshot and switches labels to Russian without retaining old values", () => {
  act(() => root.render(<SessionDetails session={session} lang="en" />))
  act(() => container.querySelector("summary")!.click())
  act(() =>
    root.render(
      <SessionDetails
        session={{ ...session, model: "synthetic/new", createdAt: "invalid" }}
        lang="ru"
      />,
    ),
  )
  expect(container.querySelector("details")?.open).toBe(true)
  expect(container.querySelector("summary")?.textContent).toBe("Сведения о сессии")
  expect(values()[3]).toBe("invalid")
  expect(values()[4]).toBe("synthetic/new")
  expect(container.textContent).not.toContain("synthetic/model:high")
})

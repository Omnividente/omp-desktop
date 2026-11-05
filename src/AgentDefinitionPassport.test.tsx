/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { AgentDefinitionPassport } from "./AgentDefinitionPassport"
import type { OmpAgentInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const agent: OmpAgentInfo = {
  name: "synthetic",
  description: "Synthetic definition",
  source: "project",
  enabled: true,
  modelOverride: null,
  defaultModelSelectors: [],
}
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function render(value: OmpAgentInfo, language: "ru" | "en" = "en") {
  act(() => root.render(<AgentDefinitionPassport agent={value} language={language} />))
}

it("keeps legacy and configured placeholders explicitly unavailable", () => {
  render(agent)
  expect(container.textContent).toContain("Definition metadata unavailable")
  render({ ...agent, source: "configured", definition: null }, "ru")
  expect(container.textContent).toContain("Метаданные определения недоступны")
  expect(container.querySelector("time")).toBeNull()
})

it("distinguishes absent, null, empty, wildcard, false and truncated declaration states", () => {
  render({
    ...agent,
    definition: {
      sourceFile: "synthetic.md",
      observedAt: 1700000000000,
      contextCwd: "/synthetic/project",
      fields: {
        tools: { state: "empty", text: null },
        spawns: { state: "wildcard", text: "*" },
        thinkingLevel: { state: "absent", text: null },
        output: { state: "null", text: null },
        blocking: { state: "value", text: "false" },
        structured: { state: "truncated", text: "example" },
      },
    },
  })
  for (const value of [
    "Explicit empty value",
    "Explicit *",
    "Not declared",
    "Explicit null",
    "false",
    "Truncated: example",
  ])
    expect(container.textContent).toContain(value)
  expect(container.textContent).toContain("not the session’s effective permissions")
  expect(container.querySelector<HTMLDetailsElement>("details")!.open).toBe(false)
  expect(container.querySelector<HTMLDetailsElement>("dd details")!.open).toBe(false)
  expect(container.querySelectorAll("button,input,select,textarea")).toHaveLength(0)
})

it("renders declaration values as bounded inert text and unknown states without payload", () => {
  render({
    ...agent,
    source: "bundled",
    definition: {
      sourceFile: "synthetic.md",
      observedAt: Number.NaN,
      contextCwd: null,
      fields: {
        tools: {
          state: "value",
          text: "<img src=x onerror=alert(1)>" + "x".repeat(900) + "\u202e",
        },
        spawns: { state: "future", text: "private-unknown-payload" },
        thinkingLevel: {
          state: "unsupported",
          text: "private-invalid-payload",
        },
      },
    },
  })
  expect(container.querySelector("img")).toBeNull()
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>")
  expect(container.textContent).not.toContain("x".repeat(513))
  expect(container.textContent).not.toContain("private-")
  expect(container.textContent).toContain("export may normalize")
  expect(container.querySelector("time")).toBeNull()
})

it("does not expose unexpected output schemas and labels shortened provenance", () => {
  render({
    ...agent,
    definition: {
      sourceFile: "synthetic.md",
      sourceFileTruncated: true,
      observedAt: 0,
      contextCwd: "/synthetic/" + "p".repeat(600),
      fields: {
        output: { state: "value", text: "private-schema-contents" },
      },
    },
  })
  expect(container.textContent).not.toContain("private-schema-contents")
  expect(container.textContent).toContain("Unsupported in passport")
  expect(container.textContent).toContain("synthetic.md (Truncated)")
  expect(container.querySelector("time")).toBeNull()
  expect(container.querySelector("dd details")!.textContent).toContain("… (Truncated)")
})

it("preserves a POSIX filename containing a literal backslash", () => {
  render({
    ...agent,
    definition: { sourceFile: "a\\b.md", observedAt: 1700000000000, contextCwd: null, fields: {} },
  })
  expect(container.textContent).toContain("a\\b.md")
})

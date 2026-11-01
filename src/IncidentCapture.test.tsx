/** @vitest-environment jsdom */
import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IncidentCenter } from "./IncidentCenter"
import { saveTerminalCapture } from "./api"
import type { RuntimeIncident } from "./runtimeIncidents"
import type { TerminalCapture, TerminalTab } from "./types"
import type { Lang } from "./i18n"
vi.mock("./api", () => ({
  saveTerminalCapture: vi.fn(),
  errorMessage: (e: Error) => e.message,
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const tab: TerminalTab = {
  id: "terminal-1",
  label: "Current Unicode session Ω",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: "provider/primary",
  currentModelRole: "default",
  currentThinking: "medium",
  currentThinkingConfigured: "medium",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}

function runtimeIncident(overrides: Partial<RuntimeIncident> = {}): RuntimeIncident {
  return {
    id: "runtime-incident-1",
    groupingKey: "incident-key",
    terminalId: "terminal-1",
    terminalLabel: "Stale session label",
    kind: "modelError",
    sourceKind: "modelError",
    status: "active",
    role: "default",
    model: "provider/primary",
    modelRole: "default",
    fallbackRole: null,
    fallbackFrom: null,
    fallbackTo: null,
    reason: "quota exhausted",
    count: 1,
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
    resolvedAt: null,
    resolutionReason: null,
    ...overrides,
  }
}

let root: Root
let host: HTMLDivElement
const noop = () => undefined
function Harness({ language }: { language: Lang }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <IncidentCenter
      incidents={[runtimeIncident()]}
      language={language}
      tabs={[tab]}
      returnFocusRef={ref}
      onClearResolved={noop}
      onClose={noop}
      onFocusTerminal={noop}
    />
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function capture(truncated: boolean): TerminalCapture {
  return {
    path: "/synthetic/" + "long-directory/".repeat(20) + "output.bin",
    metadataPath: "/synthetic/metadata.json",
    bytes: 2097152,
    firstSeq: 1,
    lastSeq: 3,
    truncated,
    droppedBytes: truncated ? 37 : 0,
  }
}
for (const language of ["ru", "en"] as const) {
  it(`explains raw privacy and limited scope before saving in ${language}`, () => {
    act(() => root.render(<Harness language={language} />))
    const button = host.querySelector<HTMLButtonElement>(".incident-save-capture")!
    const help = document.getElementById(button.getAttribute("aria-describedby")!)!
    expect(help).not.toBeNull()
    expect(help.textContent).toContain(
      language === "ru" ? "не вся история" : "not the full history",
    )
    expect(help.textContent).toContain(language === "ru" ? "секреты" : "secrets")
    expect(saveTerminalCapture).not.toHaveBeenCalled()
  })
  for (const truncated of [false, true])
    it(`reports actual truncation=${truncated} after save in ${language}`, async () => {
      vi.mocked(saveTerminalCapture).mockResolvedValue(capture(truncated))
      act(() => root.render(<Harness language={language} />))
      await act(async () =>
        host.querySelector<HTMLButtonElement>(".incident-save-capture")!.click(),
      )
      expect(saveTerminalCapture).toHaveBeenCalledExactlyOnceWith("terminal-1")
      const result = host.querySelector(".incident-capture-result")!
      expect(result.textContent).toContain(capture(truncated).path)
      expect(result.parentElement!.getAttribute("aria-live")).toBe("polite")
      const warning =
        language === "ru"
          ? "Начало вывода отброшено: 37 байт."
          : "Earlier output was dropped: 37 bytes."
      if (truncated) {
        expect(host.querySelector(".incident-capture-truncation")?.textContent).toBe(warning)
        expect(result.querySelector(".incident-capture-truncation")).toBeNull()
      } else expect(host.querySelector(".incident-capture-truncation")).toBeNull()
      expect(result.textContent).not.toContain(
        language === "ru" ? "полная история" : "full history",
      )
    })
}
it("retains save failure and enables retry without claiming a capture", async () => {
  vi.mocked(saveTerminalCapture)
    .mockRejectedValueOnce(new Error("synthetic write failure"))
    .mockResolvedValueOnce(capture(true))
  act(() => root.render(<Harness language="en" />))
  const button = host.querySelector<HTMLButtonElement>(".incident-save-capture")!
  await act(async () => button.click())
  expect(host.querySelector(".is-failed")?.textContent).toBe("synthetic write failure")
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(saveTerminalCapture).toHaveBeenCalledTimes(2)
  expect(host.querySelector(".is-failed")).toBeNull()
  expect(host.querySelector(".incident-capture-truncation")?.textContent).toContain("37 bytes")
})

/** @vitest-environment jsdom */

import { act, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IncidentCenter } from "./IncidentCenter"
import type { RuntimeIncident } from "./runtimeIncidents"
import type { TerminalTab } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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
  currentModel: "provider/primary",
  currentModelRole: "default",
  currentThinking: "medium",
  currentThinkingConfigured: "medium",
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

interface HarnessProps {
  initialIncidents: RuntimeIncident[]
  onClearResolved: () => void
  onClose: () => void
  onFocusTerminal: (terminalId: string) => void
}

function Harness({ initialIncidents, onClearResolved, onClose, onFocusTerminal }: HarnessProps) {
  const [incidents, setIncidents] = useState(initialIncidents)
  const [open, setOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <main data-background>
        <button ref={triggerRef} type="button">
          Open incidents
        </button>
      </main>
      {open && (
        <IncidentCenter
          incidents={incidents}
          language="ru"
          onClearResolved={() => {
            setIncidents((current) => current.filter((incident) => incident.status === "active"))
            onClearResolved()
          }}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
          onFocusTerminal={onFocusTerminal}
          returnFocusRef={triggerRef}
          tabs={[tab]}
        />
      )}
    </>
  )
}

describe("Runtime Incident Center modal contract", () => {
  let container: HTMLDivElement
  let root: Root
  let onClearResolved: () => void
  let onClose: () => void
  let onFocusTerminal: (terminalId: string) => void

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    onClearResolved = vi.fn()
    onClose = vi.fn()
    onFocusTerminal = vi.fn()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(async () => {
    await act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderCenter(initialIncidents: RuntimeIncident[]) {
    await act(() => {
      root.render(
        <Harness
          initialIncidents={initialIncidents}
          onClearResolved={onClearResolved}
          onClose={onClose}
          onFocusTerminal={onFocusTerminal}
        />,
      )
    })
  }

  it("makes the background inert and cycles Tab inside the dialog", async () => {
    await renderCenter([runtimeIncident()])

    const background = container.querySelector<HTMLElement>("[data-background]")
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')
    const activeFilter = container.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
    const buttons = Array.from(
      panel?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    )
    const first = buttons[0]
    const last = buttons[buttons.length - 1]

    expect(background?.hasAttribute("inert")).toBe(true)
    expect(background?.getAttribute("aria-hidden")).toBe("true")
    expect(document.activeElement).toBe(activeFilter)

    last.focus()
    last.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }),
    )
    expect(document.activeElement).toBe(first)

    first.focus()
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Tab",
        shiftKey: true,
      }),
    )
    expect(document.activeElement).toBe(last)
  })

  it("closes only the top dialog on Escape and restores trigger focus", async () => {
    await renderCenter([runtimeIncident()])
    const lowerOverlayKeydown = vi.fn()
    window.addEventListener("keydown", lowerOverlayKeydown)

    const activeFilter = container.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
    await act(() => {
      activeFilter?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>("[data-background] button")
    expect(onClose).toHaveBeenCalledOnce()
    expect(lowerOverlayKeydown).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(container.querySelector("[data-background]")?.hasAttribute("inert")).toBe(false)

    window.removeEventListener("keydown", lowerOverlayKeydown)
  })

  it("keeps focus in the dialog after clearing resolved incidents", async () => {
    await renderCenter([
      runtimeIncident(),
      runtimeIncident({
        id: "runtime-incident-2",
        groupingKey: "resolved-key",
        status: "resolved",
        resolvedAt: 2_000,
        resolutionReason: "recovered",
      }),
    ])

    const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Очистить разрешённые",
    )
    await act(() => clearButton?.click())

    expect(onClearResolved).toHaveBeenCalledOnce()
    expect(clearButton?.disabled).toBe(true)
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[aria-pressed="true"]'),
    )
  })

  it("uses the live tab label and exposes incident count as a status", async () => {
    await renderCenter([runtimeIncident()])

    expect(container.querySelector(".incident-terminal strong")?.textContent).toBe(
      "Current Unicode session Ω",
    )
    const status = container.querySelector<HTMLElement>('[role="status"]')
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.textContent).toContain("1")
  })

  it("requests terminal focus without restoring focus to the trigger", async () => {
    await renderCenter([runtimeIncident()])
    const openTerminal = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Открыть терминал"),
    )
    await act(() => openTerminal?.click())

    expect(onFocusTerminal).toHaveBeenCalledWith("terminal-1")
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(
      container.querySelector<HTMLButtonElement>("[data-background] button"),
    )
  })
})

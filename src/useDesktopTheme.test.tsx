/** @vitest-environment jsdom */
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopTheme } from "./types"
import { useDesktopTheme } from "./useDesktopTheme"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({ preference }: { preference: DesktopTheme }) {
  useDesktopTheme(preference)
  return null
}

describe("saved Desktop theme lifecycle", () => {
  let root: Root
  let container: HTMLDivElement
  let dark: boolean
  let listeners: Set<() => void>
  let allListeners: (() => void)[]
  let query: MediaQueryList
  const scheme = () => document.documentElement.dataset.desktopTheme
  const render = (preference: DesktopTheme) =>
    act(() =>
      root.render(
        <StrictMode>
          <Consumer preference={preference} />
        </StrictMode>,
      ),
    )
  const os = (value: boolean) =>
    act(() => {
      dark = value
      for (const listener of listeners) listener()
    })

  beforeEach(() => {
    dark = false
    listeners = new Set()
    allListeners = []
    query = {
      get matches() {
        return dark
      },
      addEventListener: vi.fn((_event, listener: () => void) => {
        listeners.add(listener)
        allListeners.push(listener)
      }),
      removeEventListener: vi.fn((_event, listener: () => void) => listeners.delete(listener)),
    } as unknown as MediaQueryList
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => query),
    )
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    document.documentElement.removeAttribute("data-desktop-theme")
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it("follows OS only in System and immediately rereads it when returning to System", () => {
    render("system")
    expect(scheme()).toBe("light")
    expect(listeners.size).toBe(1)
    os(true)
    expect(scheme()).toBe("dark")
    render("light")
    expect(listeners.size).toBe(0)
    os(true)
    expect(scheme()).toBe("light")
    act(() => allListeners.forEach((listener) => listener()))
    expect(scheme()).toBe("light")
    render("system")
    expect(scheme()).toBe("dark")
    render("dark")
    os(false)
    expect(scheme()).toBe("dark")
    render("system")
    expect(scheme()).toBe("light")
  })

  it("cleans subscriptions and restores DOM ownership across unmount/remount", () => {
    document.documentElement.setAttribute("data-desktop-theme", "prior")
    render("system")
    expect(listeners.size).toBe(1)
    act(() => root.render(null))
    expect(listeners.size).toBe(0)
    expect(scheme()).toBe("prior")
    os(true)
    act(() => allListeners.forEach((listener) => listener()))
    expect(scheme()).toBe("prior")
    render("system")
    expect(scheme()).toBe("dark")
    expect(listeners.size).toBe(1)
  })

  it.each([
    undefined,
    () => {
      throw new Error("Unavailable")
    },
  ])("falls back to Dark when system detection is unavailable", (matchMedia) => {
    vi.stubGlobal("matchMedia", matchMedia)
    render("system")
    expect(scheme()).toBe("dark")
    render("light")
    expect(scheme()).toBe("light")
  })

  it("supports the legacy media listener API with cleanup", () => {
    query = {
      get matches() {
        return dark
      },
      addListener: vi.fn((listener: () => void) => listeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
    } as unknown as MediaQueryList
    render("system")
    expect(scheme()).toBe("light")
    expect(listeners.size).toBe(1)
    os(true)
    expect(scheme()).toBe("dark")
    render("dark")
    expect(listeners.size).toBe(0)
  })

  it("explicit preferences do not even subscribe to OS changes", () => {
    render("dark")
    render("light")
    expect(window.matchMedia).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })
})

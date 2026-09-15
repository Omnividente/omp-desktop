/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClientUpdateNotice } from "./ClientUpdateNotice"
import { UpdateNotice } from "./UpdateNotice"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("update release-note actions", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("offers release notes and a persistent-delay action for Desktop", () => {
    const onInstall = vi.fn()
    const onRemindLater = vi.fn()
    const onViewChanges = vi.fn()
    act(() => {
      root.render(
        <ClientUpdateNotice
          info={{ version: "0.8.0", date: null, body: "Release details" }}
          installing={false}
          language="en"
          onInstall={onInstall}
          onRemindLater={onRemindLater}
          onViewChanges={onViewChanges}
        />,
      )
    })

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    const byText = (text: string) => buttons.find((button) => button.textContent?.includes(text))
    act(() => byText("What's new")?.click())
    act(() => byText("Remind me in 5 hours")?.click())
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click())

    expect(onViewChanges).toHaveBeenCalledTimes(1)
    expect(onRemindLater).toHaveBeenCalledTimes(2)
    expect(onInstall).not.toHaveBeenCalled()
  })

  it("offers exact-version release notes for an OMP update", () => {
    const onViewChanges = vi.fn()
    act(() => {
      root.render(
        <UpdateNotice
          disabled={false}
          info={{
            hasUpdate: true,
            currentVersion: "18.0.11",
            latestVersion: "18.1.0",
            message: "New version available",
          }}
          language="en"
          onRemindLater={vi.fn()}
          onUpdate={vi.fn()}
          onViewChanges={onViewChanges}
        />,
      )
    })

    const releaseNotes = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("What's new"),
    )
    act(() => releaseNotes?.click())

    expect(onViewChanges).toHaveBeenCalledTimes(1)
  })
})

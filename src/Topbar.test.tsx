/** @vitest-environment jsdom */

import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Topbar } from "./Topbar"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("Topbar OMP update indicator", () => {
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

  it("keeps a direct update action visible while an OMP update is pending", () => {
    const onUpdate = vi.fn()
    act(() => {
      root.render(
        <Topbar
          appVersion="0.7.1"
          checkingUpdate={false}
          incidentActiveTerminalCount={0}
          incidentCenterOpen={false}
          incidentTriggerRef={createRef<HTMLButtonElement>()}
          language="en"
          onOpenIncidentCenter={vi.fn()}
          onOpenResourceHealth={vi.fn()}
          onOpenSettings={vi.fn()}
          onRefresh={vi.fn()}
          onUpdate={onUpdate}
          refreshing={false}
          resourceHealth={null}
          resourceHealthOpen={false}
          resourceTriggerRef={createRef<HTMLButtonElement>()}
          runtime={{
            platform: "windows",
            arch: "x86_64",
            language: "en",
            ompAvailable: true,
            ompExecutable: "omp",
            ompVersion: "omp/18.0.11",
            sessionRoot: "/tmp/sessions",
          }}
          selectedWorkspace={null}
          updateInfo={{
            hasUpdate: true,
            currentVersion: "omp/18.0.11",
            latestVersion: "18.0.12",
            message: "Update available",
          }}
        />,
      )
    })

    const indicator = container.querySelector<HTMLButtonElement>(".update-pill")
    expect(indicator?.textContent).toContain("18.0.12")
    expect(indicator?.title).toBe("Update available")
    act(() => indicator?.click())
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })
})

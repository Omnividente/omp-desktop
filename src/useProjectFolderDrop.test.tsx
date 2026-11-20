/** @vitest-environment jsdom */

import { PhysicalPosition } from "@tauri-apps/api/dpi"
import type { DragDropEvent } from "@tauri-apps/api/webview"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { subscriptions, unlisten } = vi.hoisted(() => ({
  subscriptions: [] as Array<(event: { payload: DragDropEvent }) => void>,
  unlisten: vi.fn(),
}))

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: DragDropEvent }) => void) => {
      subscriptions.push(handler)
      return Promise.resolve(unlisten)
    },
  }),
}))

import { isProjectDropPoint, useProjectFolderDrop } from "./useProjectFolderDrop"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const elementFromPoint = vi.fn<(x: number, y: number) => Element | null>()

function DropFixture({ onDrop }: { onDrop: (paths: string[]) => void }) {
  const active = useProjectFolderDrop(onDrop)
  return (
    <>
      <aside className="project-rail" data-project-drop-target="">
        <span className="rail-child" />
      </aside>
      <span className={active ? "drop-active" : "drop-idle"} />
    </>
  )
}

describe("useProjectFolderDrop", () => {
  let container: HTMLDivElement
  let root: Root
  let rail: HTMLElement
  let originalDevicePixelRatio: PropertyDescriptor | undefined

  beforeEach(() => {
    originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")
    subscriptions.length = 0
    unlisten.mockClear()
    elementFromPoint.mockReset()
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    if (originalDevicePixelRatio) {
      Object.defineProperty(window, "devicePixelRatio", originalDevicePixelRatio)
    } else {
      Reflect.deleteProperty(window, "devicePixelRatio")
    }
  })

  async function mount(onDrop: (paths: string[]) => void) {
    await act(async () => root.render(<DropFixture onDrop={onDrop} />))
    await act(async () => {
      await Promise.resolve()
    })
    rail = container.querySelector<HTMLElement>("aside.project-rail")!
    expect(subscriptions).toHaveLength(1)
    return subscriptions[0]!
  }

  const emit = async (
    handler: (event: { payload: DragDropEvent }) => void,
    payload: DragDropEvent,
  ) => {
    await act(async () => handler({ payload }))
  }

  it("highlights the rail while the native cursor is over it and clears on leave", async () => {
    const handler = await mount(vi.fn())
    elementFromPoint.mockReturnValue(rail)
    await emit(handler, {
      type: "enter",
      paths: ["D:/projects/app"],
      position: new PhysicalPosition(12, 30),
    })
    expect(container.querySelector(".drop-active")).not.toBeNull()

    elementFromPoint.mockReturnValue(null)
    await emit(handler, { type: "over", position: new PhysicalPosition(900, 300) })
    expect(container.querySelector(".drop-active")).toBeNull()

    elementFromPoint.mockReturnValue(rail)
    await emit(handler, { type: "over", position: new PhysicalPosition(12, 30) })
    expect(container.querySelector(".drop-active")).not.toBeNull()

    await emit(handler, { type: "leave" })
    expect(container.querySelector(".drop-active")).toBeNull()
  })

  it("adds projects only when the folder is dropped on the rail", async () => {
    const onDrop = vi.fn()
    const handler = await mount(onDrop)

    elementFromPoint.mockReturnValue(null)
    await emit(handler, {
      type: "drop",
      paths: ["D:/ignored"],
      position: new PhysicalPosition(900, 300),
    })
    expect(onDrop).not.toHaveBeenCalled()
    expect(container.querySelector(".drop-active")).toBeNull()

    elementFromPoint.mockReturnValue(rail)
    await emit(handler, {
      type: "drop",
      paths: ["D:/projects/app"],
      position: new PhysicalPosition(20, 40),
    })
    expect(onDrop).toHaveBeenCalledWith(["D:/projects/app"])
    expect(container.querySelector(".drop-active")).toBeNull()
  })

  it("converts physical pixels from the native event into CSS pixels", async () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
    const handler = await mount(vi.fn())
    elementFromPoint.mockReturnValue(rail)
    await emit(handler, {
      type: "enter",
      paths: ["D:/projects/app"],
      position: new PhysicalPosition(40, 60),
    })
    expect(elementFromPoint).toHaveBeenCalledWith(20, 30)
  })

  it("removes the native listener when unmounted", async () => {
    await mount(vi.fn())
    await act(async () => root.unmount())
    expect(unlisten).toHaveBeenCalledOnce()
  })
})

describe("isProjectDropPoint", () => {
  it("accepts rail descendants and rejects other elements", () => {
    const rail = document.createElement("aside")
    rail.setAttribute("data-project-drop-target", "")
    const child = document.createElement("span")
    rail.appendChild(child)
    expect(isProjectDropPoint({ x: 10, y: 10 }, 1, () => child)).toBe(true)
    expect(isProjectDropPoint({ x: 10, y: 10 }, 1, () => document.createElement("div"))).toBe(false)
    expect(isProjectDropPoint({ x: 10, y: 10 }, 1, () => null)).toBe(false)
  })

  it("falls back to CSS pixels when no usable scale factor is reported", () => {
    const hitTest = vi.fn<(x: number, y: number) => Element | null>(() => null)
    isProjectDropPoint({ x: 5, y: 7 }, 0, hitTest)
    isProjectDropPoint({ x: 5, y: 7 }, -1, hitTest)
    expect(hitTest).toHaveBeenNthCalledWith(1, 5, 7)
    expect(hitTest).toHaveBeenNthCalledWith(2, 5, 7)
  })
})

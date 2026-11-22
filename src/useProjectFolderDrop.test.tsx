/** @vitest-environment jsdom */

import { PhysicalPosition } from "@tauri-apps/api/dpi"
import type { DragDropEvent } from "@tauri-apps/api/webview"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useProjectFolderDrop } from "./useProjectFolderDrop"

const native = vi.hoisted(() => ({
  listen: vi.fn(),
  size: vi.fn(),
  scale: vi.fn(),
  stop: vi.fn(),
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: native.listen, size: native.size }),
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ scaleFactor: native.scale }),
}))

function Fixture({ platform, add }: { platform: string; add: (paths: string[]) => void }) {
  const active = useProjectFolderDrop(platform, (paths) => () => add(paths))
  return (
    <main>
      <aside data-project-drop-target="">
        <span>{active ? "Drop to add project" : "Projects"}</span>
      </aside>
      <section>Outside</section>
    </main>
  )
}

const physical = { width: 2000, height: 1300 }
const paths = ["/fixture/项目 ", "/fixture/other"]
const point = (x: number) => new PhysicalPosition(x, 200)

describe("project folder drop", () => {
  let container: HTMLDivElement
  let root: Root
  let receive: (event: { payload: DragDropEvent }) => void
  let previousHitTest: PropertyDescriptor | undefined
  const add = vi.fn()
  const outside = () => container.querySelector("section")
  const rail = () => container.querySelector("aside span")

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal("innerWidth", 1333)
    vi.stubGlobal("innerHeight", 866)
    vi.stubGlobal("devicePixelRatio", 2)
    native.listen.mockImplementation(async (handler: typeof receive) => {
      receive = handler
      return native.stop
    })
    native.size.mockReset().mockResolvedValue(physical)
    native.scale.mockReset().mockResolvedValue(2)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    previousHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x < 320 ? rail() : outside()),
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    if (previousHitTest) Object.defineProperty(document, "elementFromPoint", previousHitTest)
    else Reflect.deleteProperty(document, "elementFromPoint")
    vi.unstubAllGlobals()
  })

  const render = async (platform: string) => {
    await act(async () => root.render(<Fixture platform={platform} add={add} />))
  }
  const send = async (payload: DragDropEvent) => {
    await act(async () => receive({ payload }))
  }

  it.each([
    ["linux", 275, 160],
    ["windows", 550, 320],
  ])(
    "uses the actual %s viewport instead of dividing drag positions by DPR",
    async (platform, miss, hit) => {
      await render(platform)
      await send({ type: "enter", position: point(miss), paths })
      expect(container.textContent).not.toContain("Drop to add project")
      await send({ type: "drop", position: point(miss), paths })
      expect(add).not.toHaveBeenCalled()
      await send({ type: "enter", position: point(miss), paths })
      for (let i = 0; i < 3; ++i) await send({ type: "over", position: point(hit) })
      expect(native.size).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain("Drop to add project")
      await send({ type: "drop", position: point(hit), paths })
      expect(add).toHaveBeenCalledExactlyOnceWith(paths)
      expect(container.textContent).not.toContain("Drop to add project")
      expect(native.scale.mock.calls.length).toBe(platform === "linux" ? 3 : 0)
    },
  )

  it("accepts a quick release before the enter measurement without waiting for another gesture", async () => {
    await render("linux")
    let finish!: (size: typeof physical) => void
    native.size.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await send({ type: "enter", position: point(160), paths })
    await send({ type: "drop", position: point(160), paths })
    expect(add).not.toHaveBeenCalled()
    await act(async () => finish(physical))
    expect(add).toHaveBeenCalledExactlyOnceWith(paths)
    expect(container.textContent).not.toContain("Drop to add project")
  })

  it("preserves release order when the next gesture's bounds arrive first", async () => {
    await render("linux")
    await send({ type: "enter", position: point(160), paths })
    let finish!: (size: typeof physical) => void
    native.size.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await send({ type: "drop", position: point(160), paths })
    const next = ["/fixture/newer"]
    await send({ type: "enter", position: point(160), paths: next })
    await send({ type: "drop", position: point(160), paths: next })
    expect(add).not.toHaveBeenCalled()
    await act(async () => finish(physical))
    expect(add.mock.calls).toEqual([[paths], [next]])
  })

  it("cancels an in-flight drop when viewport changes or the target is covered", async () => {
    await render("linux")
    await send({ type: "enter", position: point(160), paths })
    let finish!: (size: typeof physical) => void
    native.size.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await send({ type: "drop", position: point(160), paths })
    await act(async () => {
      window.dispatchEvent(new Event("resize"))
      finish(physical)
    })
    expect(add).not.toHaveBeenCalled()
    await send({ type: "enter", position: point(160), paths })
    container.querySelector("main")!.setAttribute("inert", "")
    await send({ type: "drop", position: point(160), paths })
    expect(add).not.toHaveBeenCalled()
  })

  it("ignores a release whose target changes width before the first measurement returns", async () => {
    await render("linux")
    const bounds = vi.spyOn(container.querySelector("aside")!, "getBoundingClientRect")
    bounds.mockReturnValue(new DOMRect(0, 0, 210, 800))
    let finish!: (size: typeof physical) => void
    native.size.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await send({ type: "enter", position: point(160), paths })
    await send({ type: "drop", position: point(160), paths })
    bounds.mockReturnValue(new DOMRect(0, 0, 320, 800))
    await act(async () => finish(physical))
    expect(add).not.toHaveBeenCalled()
  })

  it("discards late enter geometry and cleans up a completed subscription", async () => {
    await render("linux")
    let finish!: (size: typeof physical) => void
    native.size.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await send({ type: "enter", position: point(160), paths })
    await send({ type: "leave" })
    await act(async () => finish(physical))
    expect(container.textContent).not.toContain("Drop to add project")
    await send({ type: "drop", position: point(160), paths })
    expect(add).not.toHaveBeenCalled()
    await render("unsupported")
    expect(native.stop).toHaveBeenCalledTimes(1)
  })
})

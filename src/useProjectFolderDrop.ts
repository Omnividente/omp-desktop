import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

const railSelector = "[data-project-drop-target]"

interface Dimensions {
  width: number
  height: number
}

interface Viewport extends Dimensions {
  pixelRatio: number
}

interface Geometry {
  viewport: Viewport
  extent: Dimensions
}

interface Gesture {
  viewport: Viewport
  measurement: Promise<Geometry | null>
  geometry: Geometry | null
  position: { x: number; y: number }
}

const viewport = (): Viewport => ({
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio,
})

const sameSize = (left: Dimensions, right: Dimensions) =>
  left.width === right.width && left.height === right.height

const sameViewport = (left: Viewport, right: Viewport) =>
  sameSize(left, right) && left.pixelRatio === right.pixelRatio

function hitsProjectRail(point: { x: number; y: number }, geometry: Geometry): boolean {
  if (
    !sameViewport(geometry.viewport, viewport()) ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= geometry.extent.width ||
    point.y >= geometry.extent.height
  ) {
    return false
  }
  const target = document.elementFromPoint(
    (point.x / geometry.extent.width) * geometry.viewport.width,
    (point.y / geometry.extent.height) * geometry.viewport.height,
  )
  return Boolean(target?.closest(railSelector) && !target.closest("[inert]"))
}

export function useProjectFolderDrop(
  platform: string | undefined,
  prepareDrop: (paths: string[]) => (() => void) | undefined,
): boolean {
  const enabled = platform === "windows" || platform === "linux"
  const [active, setActive] = useState(false)
  const prepareDropRef = useRef(prepareDrop)
  useLayoutEffect(() => {
    prepareDropRef.current = prepareDrop
  }, [prepareDrop])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let unlisten: (() => void) | undefined
    let layoutRevision = 0
    let drops = Promise.resolve()
    let drag: Gesture | null = null
    const clearHover = () => {
      drag = null
      setActive(false)
    }
    const invalidateLayout = () => {
      ++layoutRevision
      drops = Promise.resolve()
      clearHover()
    }

    let webview: ReturnType<typeof getCurrentWebview>
    try {
      webview = getCurrentWebview()
    } catch {
      return // The browser preview has no native webview.
    }
    const measure = async (initial: Viewport): Promise<Geometry | null> => {
      const [size, nativeScale] = await Promise.all([
        webview.size(),
        // Pinned Wry forwards GTK widget coordinates in logical pixels, despite the
        // PhysicalPosition wrapper. WebView2 forwards physical client coordinates.
        platform === "linux" ? getCurrentWindow().scaleFactor() : 1,
      ])
      const extent = { width: size.width / nativeScale, height: size.height / nativeScale }
      if (
        !sameViewport(initial, viewport()) ||
        ![extent.width, extent.height, initial.width, initial.height, initial.pixelRatio].every(
          (value) => Number.isFinite(value) && value > 0,
        )
      ) {
        return null
      }
      return { viewport: initial, extent }
    }

    const handle = (event: DragDropEvent) => {
      if (disposed) return
      switch (event.type) {
        case "enter": {
          clearHover()
          if (event.paths.length === 0) return
          const initial = viewport()
          const gesture: Gesture = {
            viewport: initial,
            measurement: measure(initial).catch(() => null),
            geometry: null,
            position: event.position,
          }
          drag = gesture
          void gesture.measurement.then((geometry) => {
            if (disposed || drag !== gesture || !geometry) return
            gesture.geometry = geometry
            setActive(hitsProjectRail(gesture.position, geometry))
          })
          break
        }
        case "over":
          if (drag) {
            drag.position = event.position
            setActive(drag.geometry !== null && hitsProjectRail(event.position, drag.geometry))
          }
          break
        case "drop": {
          const gesture = drag
          clearHover()
          if (!gesture || !event.paths.length || !sameViewport(gesture.viewport, viewport())) return
          if (gesture.geometry && !hitsProjectRail(event.position, gesture.geometry)) return
          const rail = document.querySelector(railSelector)
          if (!rail || rail.closest("[inert]") || document.querySelector('[aria-modal="true"]'))
            return
          const atRelease = rail.getBoundingClientRect()
          const commit = prepareDropRef.current(event.paths)
          if (!commit) return
          const revision = layoutRevision
          // Read at release even if enter is still pending. Process releases in order;
          // starting the next hover must not cancel or reorder an earlier release.
          const bounds = Promise.all([
            gesture.measurement,
            measure(gesture.viewport).catch(() => null),
          ])
          drops = drops.then(async () => {
            const [initial, current] = await bounds
            if (
              disposed ||
              revision !== layoutRevision ||
              !initial ||
              !current ||
              !rail.isConnected
            )
              return
            const now = rail.getBoundingClientRect()
            if (
              sameSize(initial.extent, current.extent) &&
              sameSize(atRelease, now) &&
              atRelease.x === now.x &&
              atRelease.y === now.y &&
              hitsProjectRail(event.position, current)
            ) {
              commit()
            }
          })
          break
        }
        case "leave":
          clearHover()
          break
      }
    }

    window.addEventListener("resize", invalidateLayout)
    void webview
      .onDragDropEvent((event) => handle(event.payload))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined) // The browser preview has no native event bridge.

    return () => {
      disposed = true
      window.removeEventListener("resize", invalidateLayout)
      unlisten?.()
    }
  }, [enabled, platform])

  return enabled && active
}

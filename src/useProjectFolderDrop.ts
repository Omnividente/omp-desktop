import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview"
import { useEffect, useRef, useState } from "react"

export const PROJECT_DROP_TARGET_SELECTOR = "[data-project-drop-target]"

interface DropPoint {
  x: number
  y: number
}

type HitTest = (x: number, y: number) => Element | null

export function isProjectDropPoint(
  position: DropPoint,
  scaleFactor: number,
  hitTest: HitTest = (x, y) => document.elementFromPoint(x, y),
): boolean {
  const scale = scaleFactor > 0 ? scaleFactor : 1
  const element = hitTest(position.x / scale, position.y / scale)
  return Boolean(element?.closest(PROJECT_DROP_TARGET_SELECTOR))
}

// Native Tauri drag events carry physical pixels and cannot be consumed per element,
// so the drop target is resolved by hit-testing the reported cursor position.
export function useProjectFolderDrop(onDrop: (paths: string[]) => void): boolean {
  const [active, setActive] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    const handle = (event: DragDropEvent) => {
      if (disposed) return
      switch (event.type) {
        case "enter":
        case "over":
          setActive(isProjectDropPoint(event.position, window.devicePixelRatio))
          break
        case "drop":
          setActive(false)
          if (isProjectDropPoint(event.position, window.devicePixelRatio)) {
            onDropRef.current(event.paths)
          }
          break
        case "leave":
          setActive(false)
          break
      }
    }

    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => handle(event.payload))
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        })
        .catch(() => undefined)
    } catch {
      // The browser preview has no native webview drag events.
    }

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return active
}

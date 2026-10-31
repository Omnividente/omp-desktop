import { useLayoutEffect } from "react"
import type { DesktopTheme } from "./types"

/** Applies the saved Desktop preference only; never changes settings or terminal colors. */
export function useDesktopTheme(preference: DesktopTheme): void {
  useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute("data-desktop-theme")
    let disposed = false
    const apply = (dark: boolean) => {
      if (!disposed) root.setAttribute("data-desktop-theme", dark ? "dark" : "light")
    }
    let unsubscribe: (() => void) | undefined
    if (preference === "system") {
      try {
        const query = window.matchMedia("(prefers-color-scheme: dark)")
        // Read current state, rather than trusting a possibly queued old event payload.
        const update = () => apply(query.matches)
        update()
        if (typeof query.addEventListener === "function") {
          query.addEventListener("change", update)
          unsubscribe = () => query.removeEventListener("change", update)
        } else if (typeof query.addListener === "function") {
          query.addListener(update)
          unsubscribe = () => query.removeListener(update)
        }
      } catch {
        // Unsupported/failed media queries keep the legacy appearance.
        apply(true)
      }
    } else {
      apply(preference !== "light")
    }
    return () => {
      disposed = true
      unsubscribe?.()
      if (previous === null) root.removeAttribute("data-desktop-theme")
      else root.setAttribute("data-desktop-theme", previous)
    }
  }, [preference])
}

import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react"

function controlAvailable(element: HTMLElement): boolean {
  if (element.matches(":disabled") || element.closest("[hidden], [inert]")) return false
  const visibility = window.getComputedStyle(element).visibility
  if (visibility === "hidden" || visibility === "collapse") return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (window.getComputedStyle(ancestor).display === "none") return false
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      const summary = ancestor.querySelector(":scope > summary")
      if (!summary?.contains(element)) return false
    }
  }
  return true
}

/** Attach the returned handler in the bubble phase so nested popups own their keys first. */
export function useModalFocus(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { enabled = true, canClose = true }: { enabled?: boolean; canClose?: boolean } = {},
) {
  useLayoutEffect(() => {
    if (!enabled) return
    const previous = document.activeElement
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && controlAvailable(previous)) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [enabled, panelRef])

  useLayoutEffect(() => {
    if (!enabled) return
    const panel = panelRef.current
    const active = document.activeElement
    // A pending operation can disable the focused button. Do not steal focus from a portal menu.
    if (
      panel &&
      (active === document.body ||
        (active instanceof HTMLElement && panel.contains(active) && !controlAvailable(active)))
    ) {
      panel.focus({ preventScroll: true })
    }
  })

  return (event: KeyboardEvent<HTMLElement>) => {
    if (
      !enabled ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return
    if (event.key === "Escape") {
      // The platform select popup must receive Escape without closing its parent dialog.
      if (event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      event.stopPropagation()
      if (canClose) onClose()
    } else if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const panel = panelRef.current
      if (!panel) return
      const controls = [
        ...panel.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, [tabindex], [contenteditable='true']",
        ),
      ].filter((element) => element.tabIndex >= 0 && controlAvailable(element))
      const first = controls[0]
      const last = controls[controls.length - 1]
      const active = document.activeElement
      if (
        !first ||
        !controls.includes(active as HTMLElement) ||
        active === (event.shiftKey ? first : last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus({ preventScroll: true })
        if (!first) panel.focus({ preventScroll: true })
      }
    }
  }
}

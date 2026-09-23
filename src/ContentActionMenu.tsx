import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

interface ContentActionMenuProps {
  left: number
  top: number
  actions: Array<{ label: string; disabled?: boolean; run: () => void }>
  onDismiss: (restoreFocus: boolean) => void
}

/** Shared by terminal selections and transcript content; never changes selection on pointer down. */
export function ContentActionMenu({ left, top, actions, onDismiss }: ContentActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left, top })
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    if (!bounds) return
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)),
    })
  }, [left, top, actions.length])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismissRef.current(false)
    }
    const dismiss = () => dismissRef.current(false)
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) dismiss()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        dismissRef.current(true)
      } else if (event.key === "Tab") {
        const inside = menuRef.current?.contains(document.activeElement) ?? false
        if (inside) {
          // Consume before restoring the origin: this Tab must not reach the PTY
          // or the parent dialog, nor navigate from a soon-to-be-removed item.
          event.preventDefault()
          event.stopPropagation()
        }
        dismissRef.current(inside)
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        )
        if (!buttons.length) return
        event.preventDefault()
        event.stopPropagation()
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          current < 0
            ? event.key === "ArrowDown"
              ? 0
              : buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        buttons[next].focus({ preventScroll: true })
      }
    }
    window.addEventListener("pointerdown", outside, true)
    window.addEventListener("keydown", keyboard, true)
    window.addEventListener("resize", dismiss)
    window.addEventListener("blur", dismiss)
    window.addEventListener("scroll", scroll, true)
    return () => {
      window.removeEventListener("pointerdown", outside, true)
      window.removeEventListener("keydown", keyboard, true)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("blur", dismiss)
      window.removeEventListener("scroll", scroll, true)
    }
  }, [])

  return createPortal(
    <div
      className="content-action-menu"
      ref={menuRef}
      role="menu"
      style={{ position: "fixed", left: position.left, top: position.top }}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          role="menuitem"
          type="button"
          disabled={action.disabled}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

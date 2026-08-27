import { useEffect } from "react"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import { MAX_TOASTS, TOAST_TTL_MS, type ToastItem } from "./toastQueue"

export type { ToastItem } from "./toastQueue"

interface ToastContainerProps {
  toasts: ToastItem[]
  language: Lang
  onDismiss: (id: string) => void
}

export function ToastContainer({ toasts, language, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  // The queue is already bounded; slicing only guards against a caller that
  // hands over an unbounded list.
  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.slice(-MAX_TOASTS).map((toast) => (
        <ToastSingle key={toast.id} toast={toast} language={language} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastSingle({
  toast,
  language,
  onDismiss,
}: {
  toast: ToastItem
  language: Lang
  onDismiss: (id: string) => void
}) {
  // Keyed on the toast id only: coalescing a repeat must not restart the timer.
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(toast.id), TOAST_TTL_MS)
    return () => window.clearTimeout(timeout)
  }, [toast.id, onDismiss])

  return (
    <div className={`${toast.kind}-toast`} role={toast.kind === "error" ? "alert" : "status"}>
      <Icon name={toast.kind === "error" ? "alert" : "spark"} size={17} />
      <span className="toast-message" title={toast.truncated ? toast.fullMessage : undefined}>
        {toast.message}
        {toast.count > 1 && <span className="toast-count">{` \u00d7${toast.count}`}</span>}
      </span>
      <button onClick={() => onDismiss(toast.id)} title={t(language, "close")} type="button">
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

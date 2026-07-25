import { useEffect } from "react";
import { Icon } from "./Icon";
import { t, type Lang } from "./i18n";

export interface ToastItem {
  id: string;
  kind: "error" | "notice";
  message: string;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  language: Lang;
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, language, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.slice(-4).map((toast) => (
        <ToastSingle
          key={toast.id}
          toast={toast}
          language={language}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

function ToastSingle({
  toast,
  language,
  onDismiss,
}: {
  toast: ToastItem;
  language: Lang;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(toast.id), 5_500);
    return () => window.clearTimeout(timeout);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`${toast.kind}-toast`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <Icon name={toast.kind === "error" ? "alert" : "spark"} size={17} />
      <span>{toast.message}</span>
      <button onClick={() => onDismiss(toast.id)} title={t(language, "close")} type="button">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

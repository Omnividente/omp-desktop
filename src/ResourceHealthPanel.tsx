import { useEffect, useRef, type MouseEvent, type RefObject } from "react"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import { formatBytes, resourcePurposeLabel, resourceSeverityLabel } from "./resourceHealth"
import type { ResourceHealthSnapshot } from "./types"

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ResourceHealthPanelProps {
  error: string | null
  language: Lang
  onClose: () => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
  snapshot: ResourceHealthSnapshot | null
}

export function ResourceHealthPanel({
  error,
  language,
  onClose,
  returnFocusRef,
  snapshot,
}: ResourceHealthPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const returnFocusTarget = returnFocusRef.current
    const panel = panelRef.current
    const backdrop = panel?.parentElement
    const backgroundRoot = backdrop?.parentElement
    const backgroundElements = new Map<
      HTMLElement,
      { previousAriaHidden: string | null; hadInert: boolean }
    >()
    const makeBackgroundInert = (element: Element) => {
      if (
        !(element instanceof HTMLElement) ||
        element === backdrop ||
        backgroundElements.has(element)
      )
        return
      backgroundElements.set(element, {
        previousAriaHidden: element.getAttribute("aria-hidden"),
        hadInert: element.hasAttribute("inert"),
      })
      element.setAttribute("aria-hidden", "true")
      element.setAttribute("inert", "")
    }
    const syncBackground = () => {
      if (!backgroundRoot) return
      for (const element of backgroundRoot.children) makeBackgroundInert(element)
    }

    syncBackground()
    const backgroundObserver = backgroundRoot ? new MutationObserver(syncBackground) : null
    if (backgroundRoot) backgroundObserver?.observe(backgroundRoot, { childList: true })
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (event.key !== "Tab" || !panel) return

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute("disabled") && !element.hidden)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const activeElement = document.activeElement
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const focusOutsidePanel = !(activeElement instanceof Node) || !panel.contains(activeElement)
      if (event.shiftKey && (activeElement === first || focusOutsidePanel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || focusOutsidePanel)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      backgroundObserver?.disconnect()
      for (const [element, { previousAriaHidden, hadInert }] of backgroundElements) {
        if (previousAriaHidden === null) element.removeAttribute("aria-hidden")
        else element.setAttribute("aria-hidden", previousAriaHidden)
        if (!hadInert) element.removeAttribute("inert")
      }
      window.requestAnimationFrame(() => returnFocusTarget?.focus())
    }
  }, [onClose, returnFocusRef])

  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }
  const severity = snapshot?.severity ?? "ok"
  const status = snapshot
    ? resourceSeverityLabel(language, snapshot.severity)
    : error
      ? t(language, "resourceUnavailable")
      : t(language, "resourceLoading")
  const action =
    snapshot?.severity === "critical"
      ? t(language, "resourceCriticalAction")
      : snapshot?.severity === "warning"
        ? t(language, "resourceWarningAction")
        : null

  return (
    <div className="resource-backdrop" onMouseDown={closeOnBackdrop}>
      <section
        aria-labelledby="resource-health-title"
        aria-modal="true"
        className="resource-panel"
        role="dialog"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="resource-panel-header">
          <div>
            <span className="eyebrow">OMP Desktop</span>
            <h2 id="resource-health-title">{t(language, "resourceHealth")}</h2>
          </div>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            onClick={onClose}
            ref={closeRef}
            title={t(language, "close")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        <div aria-live="polite" className={`resource-summary is-${severity}`}>
          <Icon name={severity === "ok" ? "check" : "alert"} size={18} />
          <strong>{status}</strong>
        </div>

        {error && !snapshot && <p className="resource-error">{error}</p>}
        {action && <p className={`resource-action is-${severity}`}>{action}</p>}

        {snapshot && (
          <div className="resource-panel-scroll">
            <section className={`resource-card is-${snapshot.memory.severity}`}>
              <div className="resource-card-heading">
                <strong>{t(language, "resourceMemory")}</strong>
                <span>{resourceSeverityLabel(language, snapshot.memory.severity)}</span>
              </div>
              <meter
                aria-label={`${t(language, "resourceMemory")}: ${t(language, "resourceMemoryAvailable")
                  .replace("{available}", formatBytes(snapshot.memory.availableBytes))
                  .replace("{total}", formatBytes(snapshot.memory.totalBytes))} · ${resourceSeverityLabel(language, snapshot.memory.severity)}`}
                max={snapshot.memory.totalBytes || 1}
                min={0}
                value={snapshot.memory.availableBytes}
              />
              <p>
                {t(language, "resourceMemoryAvailable")
                  .replace("{available}", formatBytes(snapshot.memory.availableBytes))
                  .replace("{total}", formatBytes(snapshot.memory.totalBytes))}
                {` · ${resourceSeverityLabel(language, snapshot.memory.availableSeverity)}`}
              </p>
              <p>
                <strong>{t(language, "resourceSwap")}: </strong>
                {snapshot.memory.totalSwapBytes > 0
                  ? `${t(language, "resourceSwapUsed")
                      .replace("{used}", formatBytes(snapshot.memory.usedSwapBytes))
                      .replace(
                        "{total}",
                        formatBytes(snapshot.memory.totalSwapBytes),
                      )} · ${resourceSeverityLabel(language, snapshot.memory.swapSeverity)}`
                  : "—"}
              </p>
            </section>

            <section className="resource-group" aria-labelledby="resource-disks-title">
              <h3 id="resource-disks-title">{t(language, "resourceDisk")}</h3>
              {snapshot.volumes.map((volume) => (
                <article className={`resource-card is-${volume.severity}`} key={volume.mountPath}>
                  <div className="resource-card-heading">
                    <strong>{volume.mountPath}</strong>
                    <span>
                      {volume.purposes
                        .map((purpose) => resourcePurposeLabel(language, purpose))
                        .join(" · ")}
                      {` · ${resourceSeverityLabel(language, volume.severity)}`}
                    </span>
                  </div>
                  <meter
                    aria-label={`${volume.mountPath}: ${t(language, "resourceDiskAvailable")
                      .replace("{available}", formatBytes(volume.availableBytes))
                      .replace("{total}", formatBytes(volume.totalBytes))} · ${resourceSeverityLabel(language, volume.severity)}`}
                    max={volume.totalBytes || 1}
                    min={0}
                    value={volume.availableBytes}
                  />
                  <p>
                    {t(language, "resourceDiskAvailable")
                      .replace("{available}", formatBytes(volume.availableBytes))
                      .replace("{total}", formatBytes(volume.totalBytes))}
                  </p>
                </article>
              ))}
            </section>

            <section className="resource-group" aria-labelledby="resource-processes-title">
              <h3 id="resource-processes-title">{t(language, "resourceProcesses")}</h3>
              <div className="resource-process-list">
                {snapshot.processes.map((process) => (
                  <div className="resource-process" key={`${process.source}-${process.processId}`}>
                    <span>
                      {process.source === "desktop"
                        ? t(language, "resourceDesktopProcess")
                        : t(language, "resourceOmpProcess")}
                      {process.terminalId ? ` · ${process.terminalId}` : ""}
                    </span>
                    <strong>{formatBytes(process.residentBytes)}</strong>
                  </div>
                ))}
              </div>
              <p className="resource-scope-note">{t(language, "resourceScopeNote")}</p>
            </section>
          </div>
        )}

        {snapshot && (
          <footer className="resource-panel-footer">
            {t(language, "resourceMeasuredAt").replace(
              "{time}",
              new Date(snapshot.sampledAt).toLocaleTimeString(
                language === "ru" ? "ru-RU" : "en-US",
              ),
            )}
          </footer>
        )}
      </section>
    </div>
  )
}

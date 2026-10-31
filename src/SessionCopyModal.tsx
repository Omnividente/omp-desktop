import { useEffect, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { errorMessage, importSessions } from "./api"
import { Icon } from "./Icon"
import { t, type Lang } from "./i18n"
import type { ImportBatchPayload, SessionSummary } from "./types"
import { useModalFocus } from "./useModalFocus"

interface SessionCopyModalProps {
  session: SessionSummary
  language: Lang
  sourceBusy?: boolean
  onClose: () => void
  onImported: (result: ImportBatchPayload) => void | Promise<void>
}

// Validate the snapshot consumed by App before any state setter sees it. Extra fields
// are allowed for forward compatibility; known render-facing DTO fields are not.
function usableCopyBootstrap(value: unknown): boolean {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  const strings = (value: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof value[key] === "string")
  const nullableStrings = (value: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => value[key] === null || typeof value[key] === "string")
  const numbers = (value: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
  // Rust stores milliseconds as u64; the UI's Intl formatter also requires a valid Date.
  const timestamp = (value: unknown) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  const booleans = (value: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof value[key] === "boolean")
  const stringArray = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
  const stringMap = (value: unknown) =>
    record(value) && Object.values(value).every((item) => typeof item === "string")
  if (!record(value) || !record(value.settings) || !record(value.runtime)) return false
  const settings = value.settings
  const runtime = value.runtime
  const warning = settings.settingsWarning
  return (
    strings(settings, ["appFontFamily", "terminalFontFamily", "language"]) &&
    numbers(settings, ["appFontSize", "terminalFontSize"]) &&
    nullableStrings(settings, ["ompExecutable", "sessionRoot", "lastWorkspace"]) &&
    [
      "recentWorkspaces",
      "hiddenWorkspaces",
      "primaryProviderPins",
      "proxyProviders",
      "providerEnvKeys",
    ].every((key) => stringArray(settings[key])) &&
    stringMap(settings.workspaceNames) &&
    stringMap(settings.sessionTitlePins) &&
    ["expanded", "collapsed", "autoHide"].includes(settings.railMode as string) &&
    // Native AppSettings omits these two None warnings (serde skip_serializing_if).
    // Other default/Option fields are still serialized; do not default missing render fields.
    (!Object.hasOwn(settings, "secretStorageWarning") ||
      settings.secretStorageWarning === null ||
      typeof settings.secretStorageWarning === "string") &&
    (!Object.hasOwn(settings, "settingsWarning") ||
      warning === null ||
      (record(warning) &&
        strings(warning, ["code", "message"]) &&
        nullableStrings(warning, ["details"]))) &&
    strings(runtime, ["platform", "arch", "language", "ompExecutable", "sessionRoot"]) &&
    booleans(runtime, ["ompAvailable"]) &&
    nullableStrings(runtime, ["ompVersion"]) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (item) =>
        record(item) &&
        strings(item, ["id", "title", "cwd", "projectKey", "filePath", "createdAt", "source"]) &&
        nullableStrings(item, [
          "pinnedTitle",
          "parentSessionPath",
          "model",
          "thinkingLevel",
          "configuredThinkingLevel",
        ]) &&
        timestamp(item.updatedAt) &&
        booleans(item, ["hasMessages", "primaryProviderPinned"]),
    ) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (item) =>
        record(item) &&
        strings(item, ["key", "path", "name"]) &&
        numbers(item, ["sessionCount"]) &&
        timestamp(item.lastActive) &&
        booleans(item, ["pinned"]),
    ) &&
    Array.isArray(value.sessionWarnings) &&
    value.sessionWarnings.every((item) => record(item) && strings(item, ["path", "message"]))
  )
}

/** A new import, never a relocation or a resume with a substituted cwd. */
export function SessionCopyModal({
  session,
  language,
  sourceBusy = false,
  onClose,
  onImported,
}: SessionCopyModalProps) {
  const panelRef = useRef<HTMLElement>(null)
  const alive = useRef(false)
  const busy = useRef(false)
  const pickerBusy = useRef(false)
  const pickerRequest = useRef(0)
  const [target, setTarget] = useState<string | null>(null)
  const [mode, setMode] = useState<"skip" | "copy">("skip")
  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [settled, setSettled] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const requests = pickerRequest
    alive.current = true
    return () => {
      alive.current = false
      ++requests.current
    }
  }, [])
  const close = () => {
    if (busy.current) return
    ++pickerRequest.current
    onClose()
  }
  const onKeyDown = useModalFocus(panelRef, close, { canClose: !importing })

  const choose = async () => {
    if (busy.current || pickerBusy.current || settled) return
    pickerBusy.current = true
    const request = ++pickerRequest.current
    setPicking(true)
    setError(null)
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: t(language, "sessionCopyChoose"),
      })
      if (!alive.current || request !== pickerRequest.current) return
      if (typeof path === "string" && path) setTarget(path)
    } catch (cause) {
      if (alive.current && request === pickerRequest.current)
        setError(errorMessage(cause, language))
    } finally {
      pickerBusy.current = false
      if (alive.current && request === pickerRequest.current) setPicking(false)
    }
  }

  const copy = async () => {
    if (!target || busy.current || picking || settled || sourceBusy) return
    busy.current = true
    setImporting(true)
    setError(null)
    setFeedback(null)
    try {
      const result = await importSessions([{ path: session.filePath, targetCwd: target, mode }])
      if (!alive.current) return
      const item = Array.isArray(result?.items) ? result.items[0] : null
      const knownStatus = item && ["imported", "copied", "skipped", "failed"].includes(item.status)
      if (
        !item ||
        typeof item !== "object" ||
        !knownStatus ||
        item.sourcePath !== session.filePath ||
        result.items.length !== 1 ||
        (item.status !== "failed" &&
          (typeof item.destinationPath !== "string" || !item.destinationPath.trim()))
      ) {
        setSettled(true)
        setError(t(language, "sessionCopyUnknown"))
        return
      }
      if (item.status === "failed") {
        setError(typeof item.message === "string" ? item.message : t(language, "failed"))
        return
      }
      setSettled(true)
      if (!usableCopyBootstrap(result.bootstrap)) {
        setError(t(language, "sessionCopyUnknown"))
        return
      }
      await onImported(result)
      if (alive.current) setFeedback(t(language, item.status === "skipped" ? "skipped" : "copied"))
    } catch (cause) {
      if (alive.current) {
        // An IPC rejection may have arrived after a write. Do not offer a blind resend.
        setSettled(true)
        setFeedback(null)
        setError(`${errorMessage(cause, language)} ${t(language, "sessionCopyUnknown")}`)
      }
    } finally {
      busy.current = false
      if (alive.current) setImporting(false)
    }
  }

  return (
    <div className="settings-backdrop" onMouseDown={close} role="presentation">
      <section
        aria-labelledby="session-copy-title"
        aria-modal="true"
        className="settings-panel codex-import-panel"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="settings-header">
          <h2 id="session-copy-title">{t(language, "sessionCopyTitle")}</h2>
          <button
            aria-label={t(language, "close")}
            className="icon-button"
            disabled={importing}
            onClick={close}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="settings-scroll">
          <p className="field-help">{t(language, "sessionCopyHelp")}</p>
          <p>
            {t(language, "sessionCopySource")}: {session.title}
          </p>
          <p className="field-help">{session.filePath}</p>
          <p>
            {t(language, "sessionCopyTarget")}: {target ?? "—"}
          </p>
          <button
            className="button secondary"
            disabled={importing || picking || settled}
            onClick={() => void choose()}
            type="button"
          >
            {t(language, "sessionCopyChoose")}
          </button>
          <label className="import-mode-field">
            <span>{t(language, "importMode")}</span>
            <select
              disabled={importing || settled}
              value={mode}
              onChange={(event) => setMode(event.target.value === "copy" ? "copy" : "skip")}
            >
              <option value="skip">{t(language, "importModeSkip")}</option>
              <option value="copy">{t(language, "importModeCopy")}</option>
            </select>
          </label>
          {sourceBusy && <p role="status">{t(language, "sessionCopyBusy")}</p>}
          {feedback && <p role="status">{feedback}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer className="settings-actions">
          <button className="button secondary" disabled={importing} onClick={close} type="button">
            {t(language, settled ? "close" : "cancel")}
          </button>
          <button
            className="button primary"
            disabled={!target || picking || importing || settled || sourceBusy}
            onClick={() => void copy()}
            type="button"
          >
            {t(language, importing ? "saving" : "sessionCopyConfirm")}
          </button>
        </footer>
      </section>
    </div>
  )
}

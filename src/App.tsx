import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { listen } from "@tauri-apps/api/event"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import {
  addWorkspace,
  bootstrap as loadBootstrap,
  backendErrorCode,
  checkOmpUpdate,
  closeTerminal,
  discardSwitchInputRecovery,
  deleteSession,
  errorMessage,
  importSessions,
  listCodexSessions,
  loadOmpConfig,
  removeWorkspace as removeWorkspaceFromList,
  renameWorkspace,
  sampleResourceHealth,
  saveSettingsBundle,
  setSessionTitlePin,
  setTerminalPrimaryProviderPin,
  sendSwitchInputRecovery,
  sessionLeaseConflictDetails,
  settingsUnavailableDetails,
  startTerminal,
  startWithDefaults,
  subscribeSettingsUnavailable,
  switchTerminal,
  switchInputRecoveryDetails,
  writeTerminal,
} from "./api"
import { CodexImportModal } from "./CodexImportModal"
import { ClientUpdateNotice } from "./ClientUpdateNotice"
import { IncidentCenter } from "./IncidentCenter"
import { ImportSessionModal } from "./ImportSessionModal"
import { Icon } from "./Icon"
import { matchesSelector, splitSelector, thinkingOptionsForModel } from "./ModelPicker"
import { t, type Lang, type UiKey } from "./i18n"
import { ProjectRail } from "./ProjectRail"
import {
  applyRuntimeEventToTab,
  runtimeEventFeedback,
  suppressTransientProxyError,
  runtimeFeedbackDedupeKey,
} from "./runtimeEvents"
import { forgetTerminalContinuity } from "./terminalContinuity"
import {
  activeRuntimeTerminalCount,
  applyRuntimeIncidentEvent,
  clearResolvedRuntimeIncidents,
  createRuntimeIncidentState,
  endRuntimeIncidentTerminal,
  runtimeHealthStatus,
  type RuntimeHealthStatus,
} from "./runtimeIncidents"
import { ResourceHealthPanel } from "./ResourceHealthPanel"
import { SettingsPanel } from "./SettingsPanel"
import { SettingsRecoveryScreen } from "./SettingsRecoveryScreen"
import { TerminalWorkspace } from "./TerminalWorkspace"
import { Topbar } from "./Topbar"
import { TranscriptModal } from "./TranscriptModal"
import { UpdateNotice } from "./UpdateNotice"
import {
  persistUpdateReminderSnooze,
  readUpdateReminderSnoozedUntil,
  UPDATE_REMINDER_SNOOZE_MS,
} from "./updateReminder"
import { ToastContainer } from "./ToastContainer"
import {
  createToastState,
  dismissToast as dismissToastFromState,
  enqueueToast,
  type ToastRequest,
} from "./toastQueue"
import type {
  BootstrapPayload,
  CodexSessionSummary,
  ImportItemResult,
  ImportMode,
  OmpUpdateInfo,
  ResourceHealthSnapshot,
  RailMode,
  PtyExitEvent,
  PtyRuntimeEvent,
  PtySessionEvent,
  PtySessionTitleEvent,
  PtyUpdateEvent,
  OmpConfigSnapshot,
  SessionSummary,
  SettingsUnavailableDetails,
  SingleInstanceEvent,
  TerminalTab,
  WorkspaceSummary,
} from "./types"
import {
  extractSingleInstanceWorkspace,
  localeTag,
  mergeSessionIntoPayload,
  normalizedPath,
  replaceTerminalAfterRestart,
  tabMatchesSession,
} from "./uiUtils"
import { useClientUpdater } from "./useClientUpdater"
import { useWindowActivity } from "./useWindowActivity"
import { useTranscript } from "./useTranscript"
import packageMetadata from "../package.json"
import "./App.css"

type PendingUpdateRestart = {
  updateTerminalId: string
  sourceTab: TerminalTab | null
}
type PendingRuntimeEvent = {
  event: PtyRuntimeEvent
  receivedAt: number
  terminalLabel: string | null
}

type SessionLaunchTarget = Pick<
  SessionSummary,
  | "id"
  | "title"
  | "pinnedTitle"
  | "cwd"
  | "filePath"
  | "model"
  | "thinkingLevel"
  | "configuredThinkingLevel"
  | "primaryProviderPinned"
>
const MAX_ENDED_RUNTIME_TERMINALS = 256

function settingsDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (separator < 0) return "."
  if (separator === 0) return path.slice(0, 1)
  if (separator === 2 && path[1] === ":") return path.slice(0, 3)
  return path.slice(0, separator)
}

async function runWithSessionLeaseReclaim<T>(
  language: Lang,
  confirmationKey: UiKey,
  operation: (forceSessionLease: boolean) => Promise<T>,
): Promise<T | null> {
  try {
    return await operation(false)
  } catch (error) {
    if (backendErrorCode(error) !== "session_lease_stale") throw error
    const conflict = sessionLeaseConflictDetails(error)
    const owner = conflict?.ownerPid
      ? t(language, "sessionLeaseOwnerPid").replace("{pid}", String(conflict.ownerPid))
      : t(language, "unknownSessionLeaseOwner")
    const accepted = await confirm(t(language, confirmationKey).replace("{owner}", owner), {
      title: t(language, "reclaimSessionLeaseTitle"),
      kind: "warning",
    })
    if (!accepted) return null
    return operation(true)
  }
}

function summarizeImport(items: ImportItemResult[], language: Lang): string {
  const counts = {
    imported: items.filter((item) => item.status === "imported").length,
    updated: items.filter((item) => item.status === "updated").length,
    copied: items.filter((item) => item.status === "copied").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    failed: items.filter((item) => item.status === "failed").length,
  }
  return [
    `${t(language, "imported")}: ${counts.imported}`,
    `${t(language, "updated")}: ${counts.updated}`,
    `${t(language, "copied")}: ${counts.copied}`,
    `${t(language, "skipped")}: ${counts.skipped}`,
    `${t(language, "failed")}: ${counts.failed}`,
  ].join(" · ")
}

function rememberEndedRuntimeTerminal(terminalIds: string[], terminalId: string): void {
  const existing = terminalIds.indexOf(terminalId)
  if (existing >= 0) terminalIds.splice(existing, 1)
  terminalIds.push(terminalId)
  if (terminalIds.length > MAX_ENDED_RUNTIME_TERMINALS) {
    terminalIds.splice(0, terminalIds.length - MAX_ENDED_RUNTIME_TERMINALS)
  }
}

function forgetEndedRuntimeTerminal(terminalIds: string[], terminalId: string): void {
  const existing = terminalIds.indexOf(terminalId)
  if (existing >= 0) terminalIds.splice(existing, 1)
}

async function notifyTerminalCompletion(
  tab: TerminalTab,
  event: PtyExitEvent,
  lang: Lang,
): Promise<void> {
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      granted = (await requestPermission()) === "granted"
    }
    if (!granted) return

    const title = t(lang, event.success ? "notificationSuccessTitle" : "notificationFailureTitle")
    const body = t(lang, event.success ? "notificationSuccessBody" : "notificationFailureBody")
      .replace("{title}", tab.label)
      .replace("{code}", event.error || String(event.exitCode ?? "?"))
    sendNotification({ title, body })
  } catch {
    // Notifications are optional and must never interfere with terminal cleanup.
  }
}
function App() {
  const [payload, setPayload] = useState<BootstrapPayload | null>(null)
  const proxyProvidersRef = useRef<readonly string[]>([])
  proxyProvidersRef.current = payload?.settings.proxyProviders ?? []
  const [appVersion, setAppVersion] = useState(packageMetadata.version)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [runtimeIncidentState, setRuntimeIncidentState] = useState(() =>
    createRuntimeIncidentState(Date.now()),
  )
  const [incidentCenterOpen, setIncidentCenterOpen] = useState(false)
  const incidentCenterTriggerRef = useRef<HTMLButtonElement>(null)
  const endedRuntimeTerminalIdsRef = useRef<string[]>([])
  const pendingProxyErrorsRef = useRef(new Set<string>())
  const discoveredSessionsRef = useRef(new Map<string, SessionSummary>())
  const completionNotifiedRef = useRef(new Set<string>())
  const settingsWarningShownRef = useRef<string | null>(null)
  const pendingInitialInputRef = useRef(new Map<string, string>())
  const readyTerminalIdsRef = useRef(new Set<string>())
  const restartingTerminalIdsRef = useRef(new Set<string>())
  const restartExitEventsRef = useRef(new Map<string, PtyExitEvent>())
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<{
    terminalId: string
    sequence: number
  } | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [toastState, setToastState] = useState(createToastState)
  const [launching, setLaunching] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [settingsRecovery, setSettingsRecovery] = useState<SettingsUnavailableDetails | null>(null)
  const [settingsRecoveryBusy, setSettingsRecoveryBusy] = useState(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [renamingWorkspaceKey, setRenamingWorkspaceKey] = useState<string | null>(null)
  const [workspaceNameValue, setWorkspaceNameValue] = useState("")
  const [workspaceBusyKey, setWorkspaceBusyKey] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<OmpUpdateInfo | null>(null)
  const [updateSourceTerminalId, setUpdateSourceTerminalId] = useState<string | null>(null)
  const pendingUpdateRestartRef = useRef<PendingUpdateRestart | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateNoticeVisible, setUpdateNoticeVisible] = useState(false)
  const updateInfoRef = useRef(updateInfo)
  updateInfoRef.current = updateInfo
  const updateSourceTerminalIdRef = useRef(updateSourceTerminalId)
  updateSourceTerminalIdRef.current = updateSourceTerminalId
  const ignoredUpdateReminderKeysRef = useRef(new Set<string>())
  const updateReminderSnoozedUntilRef = useRef(readUpdateReminderSnoozedUntil())
  const updateReminderTimerRef = useRef<number | null>(null)
  const [codexOpen, setCodexOpen] = useState(false)
  const [codexSessions, setCodexSessions] = useState<CodexSessionSummary[]>([])
  const [codexSelected, setCodexSelected] = useState<Record<string, boolean>>({})
  const [codexLoading, setCodexLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>("skip")
  const [pendingOmpImportPath, setPendingOmpImportPath] = useState<string | null>(null)
  const [resourceHealth, setResourceHealth] = useState<ResourceHealthSnapshot | null>(null)
  const [resourceHealthError, setResourceHealthError] = useState<string | null>(null)
  const [resourceHealthOpen, setResourceHealthOpen] = useState(false)
  const resourceHealthTriggerRef = useRef<HTMLButtonElement>(null)
  const resourceHealthSamplingRef = useRef(false)
  const [railAutoOpen, setRailAutoOpen] = useState(false)
  const [railModeSaving, setRailModeSaving] = useState(false)

  const [ompConfig, setOmpConfig] = useState<OmpConfigSnapshot | null>(null)

  useEffect(() => {
    if (!payload?.runtime.ompAvailable) return
    void loadOmpConfig().then(setOmpConfig).catch(console.error)
  }, [payload?.runtime.ompAvailable])
  const lang: Lang = payload?.settings.language === "en" ? "en" : "ru"
  const langRef = useRef(lang)
  langRef.current = lang
  const ompVersionRef = useRef(payload?.runtime.ompVersion ?? null)
  ompVersionRef.current = payload?.runtime.ompVersion ?? null
  const railMode = payload?.settings.railMode ?? "expanded"
  const {
    transcriptSession,
    transcript,
    transcriptLoading,
    transcriptError,
    transcriptSearch,
    transcriptMode,
    visibleEntries: visibleTranscriptEntries,
    loadTranscript,
    closeTranscript,
    setSearch: setTranscriptSearch,
    setMode: setTranscriptMode,
  } = useTranscript(lang)

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => undefined)
  }, [])

  useWindowActivity(tabs, activeTabId)
  const pushToast = useCallback((request: ToastRequest) => {
    setToastState((current) => enqueueToast(current, request, Date.now()))
  }, [])

  const showError = useCallback(
    (message: string) => pushToast({ kind: "error", message }),
    [pushToast],
  )

  const showNotice = useCallback(
    (message: string) => pushToast({ kind: "notice", message }),
    [pushToast],
  )

  useEffect(
    () =>
      subscribeSettingsUnavailable((recovery) => {
        setSettingsRecovery(recovery)
        setStartupError(recovery.message)
        setRefreshing(false)
        setSettingsRecoveryBusy(false)
      }),
    [],
  )

  const dismissToast = useCallback((id: string) => {
    setToastState((current) => dismissToastFromState(current, id, Date.now()))
  }, [])
  const updateReminderKey = useCallback((terminalId: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === terminalId)
    return tab?.sessionPath ?? tab?.sessionId ?? `terminal:${terminalId}`
  }, [])
  const updateReminderAllowed = useCallback(
    (terminalId: string | null) =>
      Date.now() >= updateReminderSnoozedUntilRef.current &&
      (!terminalId || !ignoredUpdateReminderKeysRef.current.has(updateReminderKey(terminalId))),
    [updateReminderKey],
  )
  const clearUpdateReminderTimer = useCallback(() => {
    if (updateReminderTimerRef.current === null) return
    window.clearTimeout(updateReminderTimerRef.current)
    updateReminderTimerRef.current = null
  }, [])
  const releaseUpdateReminderSnooze = useCallback(() => {
    updateReminderTimerRef.current = null
    updateReminderSnoozedUntilRef.current = 0
    persistUpdateReminderSnooze(0)
    const terminalId = updateSourceTerminalIdRef.current
    if (updateInfoRef.current?.hasUpdate && updateReminderAllowed(terminalId)) {
      setUpdateNoticeVisible(true)
    }
  }, [updateReminderAllowed])
  const scheduleUpdateReminderTimer = useCallback(
    (until: number) => {
      clearUpdateReminderTimer()
      const delay = Math.max(0, until - Date.now())
      if (delay === 0) {
        releaseUpdateReminderSnooze()
        return
      }
      updateReminderTimerRef.current = window.setTimeout(releaseUpdateReminderSnooze, delay)
    },
    [clearUpdateReminderTimer, releaseUpdateReminderSnooze],
  )
  const remindUpdateLater = useCallback(() => {
    const until = Date.now() + UPDATE_REMINDER_SNOOZE_MS
    updateReminderSnoozedUntilRef.current = until
    persistUpdateReminderSnooze(until)
    setUpdateNoticeVisible(false)
    scheduleUpdateReminderTimer(until)
  }, [scheduleUpdateReminderTimer])
  const dismissUpdateForSession = useCallback(() => {
    const terminalId = updateSourceTerminalIdRef.current
    if (terminalId) {
      ignoredUpdateReminderKeysRef.current.add(updateReminderKey(terminalId))
    }
    clearUpdateReminderTimer()
    updateReminderSnoozedUntilRef.current = 0
    persistUpdateReminderSnooze(0)
    setUpdateNoticeVisible(false)
  }, [clearUpdateReminderTimer, updateReminderKey])
  useEffect(() => {
    const until = updateReminderSnoozedUntilRef.current
    if (until > Date.now()) scheduleUpdateReminderTimer(until)
    else persistUpdateReminderSnooze(0)
    return clearUpdateReminderTimer
  }, [clearUpdateReminderTimer, scheduleUpdateReminderTimer])
  const {
    update: clientUpdate,
    installing: installingClientUpdate,
    dismiss: dismissClientUpdate,
    install: installAvailableClientUpdate,
  } = useClientUpdater(lang, showError)
  const sendPendingInitialInput = useCallback(
    async (terminalId: string) => {
      const initialInput = pendingInitialInputRef.current.get(terminalId)
      if (initialInput === undefined) return
      pendingInitialInputRef.current.delete(terminalId)
      try {
        await writeTerminal(terminalId, initialInput)
      } catch (error) {
        showError(errorMessage(error, lang))
      }
    },
    [lang, showError],
  )

  const queueInitialInput = useCallback(
    async (terminalId: string, initialInput: string) => {
      if (!initialInput) return
      pendingInitialInputRef.current.set(terminalId, initialInput)
      if (readyTerminalIdsRef.current.has(terminalId)) {
        await sendPendingInitialInput(terminalId)
      }
    },
    [sendPendingInitialInput],
  )

  const handleTerminalReady = useCallback(
    (terminalId: string) => {
      readyTerminalIdsRef.current.add(terminalId)
      void sendPendingInitialInput(terminalId)
    },
    [sendPendingInitialInput],
  )

  const applyPayload = useCallback(
    (next: BootstrapPayload, preferredWorkspace?: string) => {
      setPayload(next)
      setSettingsRecovery(null)
      setTabs((current) =>
        current.map((tab) => {
          const session = next.sessions.find((candidate) =>
            tabMatchesSession(tab, candidate, next.runtime.platform),
          )
          return session ? { ...tab, label: session.title, pinnedTitle: session.pinnedTitle } : tab
        }),
      )
      setStartupError(null)
      const warning = next.settings.settingsWarning
      const warningKey = warning ? `${warning.code}:${warning.details ?? ""}` : null
      if (warning && settingsWarningShownRef.current !== warningKey) {
        settingsWarningShownRef.current = warningKey
        const warningLang: Lang = next.settings.language === "en" ? "en" : "ru"
        showNotice(
          warning.code === "settings_recovered"
            ? t(warningLang, "settingsRecovered").replace(
                "{path}",
                warning.details ?? "settings.invalid.json",
              )
            : warning.message,
        )
      }
      setSelectedWorkspaceKey((current) => {
        const preferred = preferredWorkspace ?? current
        if (preferred) {
          const preferredPathKey = normalizedPath(preferred, next.runtime.platform)
          const match = next.workspaces.find(
            (workspace) =>
              workspace.key === preferred ||
              normalizedPath(workspace.path, next.runtime.platform) === preferredPathKey,
          )
          if (match) return match.key
        }
        return next.workspaces[0]?.key ?? null
      })
      setSelectedSessionId((current) =>
        current && next.sessions.some((session) => session.id === current) ? current : null,
      )
    },
    [showNotice],
  )

  const changeRailMode = useCallback(
    async (mode: RailMode) => {
      if (!payload || railModeSaving || mode === payload.settings.railMode) return
      setRailModeSaving(true)
      try {
        const result = await saveSettingsBundle({ update: { railMode: mode }, ompConfig: null })
        applyPayload(result.bootstrap, selectedWorkspaceKey ?? undefined)
        setRailAutoOpen(mode === "autoHide")
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setRailModeSaving(false)
      }
    },
    [applyPayload, lang, payload, railModeSaving, selectedWorkspaceKey, showError],
  )

  const startWorkspaceRename = useCallback((workspace: WorkspaceSummary) => {
    setRenamingWorkspaceKey(workspace.key)
    setWorkspaceNameValue(workspace.name)
  }, [])

  const submitWorkspaceRename = useCallback(
    async (workspace: WorkspaceSummary) => {
      if (renamingWorkspaceKey !== workspace.key || workspaceBusyKey === workspace.key) return
      const name = workspaceNameValue.trim()
      setRenamingWorkspaceKey(null)
      if (!name || name === workspace.name) {
        setWorkspaceNameValue("")
        return
      }
      setWorkspaceBusyKey(workspace.key)
      try {
        applyPayload(await renameWorkspace(workspace.path, name), workspace.key)
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setWorkspaceBusyKey(null)
        setWorkspaceNameValue("")
      }
    },
    [applyPayload, lang, renamingWorkspaceKey, showError, workspaceBusyKey, workspaceNameValue],
  )

  const handleWorkspaceRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, workspace: WorkspaceSummary) => {
      if (event.key === "Enter") {
        event.preventDefault()
        event.currentTarget.blur()
      } else if (event.key === "Escape") {
        event.preventDefault()
        setRenamingWorkspaceKey(null)
        setWorkspaceNameValue(workspace.name)
      }
    },
    [],
  )

  const removeWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      if (workspaceBusyKey === workspace.key) return
      const shouldRemove = await confirm(
        t(lang, "removeProjectConfirm").replace("{name}", workspace.name),
        { title: t(lang, "removeProject"), kind: "warning" },
      )
      if (!shouldRemove) return
      setWorkspaceBusyKey(workspace.key)
      try {
        applyPayload(await removeWorkspaceFromList(workspace.path))
        if (renamingWorkspaceKey === workspace.key) {
          setRenamingWorkspaceKey(null)
          setWorkspaceNameValue("")
        }
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setWorkspaceBusyKey(null)
      }
    },
    [applyPayload, lang, renamingWorkspaceKey, showError, workspaceBusyKey],
  )

  const focusPersistentRailControl = useCallback(() => {
    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLElement)) return
    const rail = activeElement.closest<HTMLElement>(".project-rail")
    if (!rail || !activeElement.closest(".project-sessions, .open-project-button")) return
    rail.querySelector<HTMLButtonElement>(".rail-open-folder")?.focus()
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      applyPayload(await loadBootstrap())
    } catch (error) {
      const recovery = settingsUnavailableDetails(error)
      if (recovery) {
        setSettingsRecovery(recovery)
        setStartupError(recovery.message)
      } else {
        const message = errorMessage(error, lang)
        setStartupError(message)
        showError(message)
      }
    } finally {
      setRefreshing(false)
    }
  }, [applyPayload, lang, showError])

  const openSettingsRecoveryFolder = useCallback(async () => {
    if (!settingsRecovery) return
    try {
      await openPath(settingsDirectory(settingsRecovery.settingsPath))
    } catch (error) {
      showError(errorMessage(error, lang))
    }
  }, [lang, settingsRecovery, showError])

  const recoverSettingsWithDefaults = useCallback(async () => {
    if (!settingsRecovery || settingsRecoveryBusy) return
    const accepted = await confirm(t(lang, "startWithDefaultsConfirm"), {
      title: t(lang, "startWithDefaultsConfirmTitle"),
      kind: "warning",
    })
    if (!accepted) return
    setSettingsRecoveryBusy(true)
    try {
      applyPayload(await startWithDefaults())
    } catch (error) {
      const recovery = settingsUnavailableDetails(error)
      if (recovery) {
        setSettingsRecovery(recovery)
        setStartupError(recovery.message)
      } else {
        showError(errorMessage(error, lang))
      }
    } finally {
      setSettingsRecoveryBusy(false)
    }
  }, [applyPayload, lang, settingsRecovery, settingsRecoveryBusy, showError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    void listen<SingleInstanceEvent>("single-instance", async (event) => {
      if (disposed) return
      const requested = extractSingleInstanceWorkspace(event.payload.args)
      if (requested) {
        try {
          const next = await addWorkspace(requested)
          if (disposed) return
          applyPayload(next, requested)
          setSelectedSessionId(null)
          setSearch("")
          return
        } catch (error) {
          if (!disposed) showError(errorMessage(error, langRef.current))
          return
        }
      }
      if (!disposed) void refresh()
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch((error) => {
        if (!disposed) showError(errorMessage(error, langRef.current))
      })
    return () => {
      disposed = true
      stop?.()
    }
  }, [applyPayload, refresh, showError])
  useEffect(() => {
    let disposed = false
    let runtimeFrame: number | null = null
    let pendingRuntimeEvents: PendingRuntimeEvent[] = []

    const flushRuntimeEvents = () => {
      runtimeFrame = null
      if (disposed) {
        pendingRuntimeEvents = []
        return
      }
      const batch = pendingRuntimeEvents.filter(
        ({ event }) => !endedRuntimeTerminalIdsRef.current.includes(event.terminalId),
      )
      pendingRuntimeEvents = []
      if (batch.length === 0) return

      setRuntimeIncidentState((current) =>
        batch.reduce(
          (next, item) =>
            applyRuntimeIncidentEvent(next, item.event, item.receivedAt, item.terminalLabel),
          current,
        ),
      )
      const eventsByTerminal = new Map<string, PtyRuntimeEvent[]>()
      for (const { event } of batch) {
        const events = eventsByTerminal.get(event.terminalId)
        if (events) events.push(event)
        else eventsByTerminal.set(event.terminalId, [event])
      }
      setTabs((current) =>
        current.map((tab) =>
          (eventsByTerminal.get(tab.id) ?? []).reduce(applyRuntimeEventToTab, tab),
        ),
      )
    }

    const queueRuntimeEvent = (event: PtyRuntimeEvent, terminalLabel: string | null) => {
      pendingRuntimeEvents.push({ event, receivedAt: Date.now(), terminalLabel })
      if (runtimeFrame === null) runtimeFrame = window.requestAnimationFrame(flushRuntimeEvents)
    }

    const unlistenSession = listen<PtySessionEvent>("pty-session", ({ payload: event }) => {
      if (disposed) return
      forgetEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, event.terminalId)
      const { session } = event
      discoveredSessionsRef.current.set(event.terminalId, session)
      setPayload((current) =>
        current ? mergeSessionIntoPayload(current, session, current.runtime.platform) : current,
      )

      setSelectedSessionId(session.id)
      setSearch("")
      setTabs((current) =>
        current.map((tab) =>
          tab.id === event.terminalId
            ? {
                ...tab,
                label: session.title,
                pinnedTitle: session.pinnedTitle,
                sessionId: session.id,
                sessionPath: session.filePath,
                currentModel: session.model ?? tab.currentModel,
                currentThinking: session.thinkingLevel ?? tab.currentThinking,
                currentThinkingConfigured:
                  session.configuredThinkingLevel ??
                  session.thinkingLevel ??
                  tab.currentThinkingConfigured,
                primaryProviderPinned: session.primaryProviderPinned,
                primaryProviderPinPending: false,
              }
            : tab,
        ),
      )
      void loadBootstrap()
        .then((next) => {
          if (disposed) return
          const latest = discoveredSessionsRef.current.get(event.terminalId)
          if (latest && latest.id !== session.id) return
          applyPayload(mergeSessionIntoPayload(next, session, next.runtime.platform))
          setSelectedSessionId(session.id)
        })
        .catch((error) => {
          if (!disposed) showError(errorMessage(error, langRef.current))
        })
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, langRef.current))
      return null
    })

    const unlistenSessionTitle = listen<PtySessionTitleEvent>(
      "pty-session-title",
      ({ payload: event }) => {
        if (disposed) return
        const title = event.title.trim()
        const terminal = tabsRef.current.find((tab) => tab.id === event.terminalId)
        if (!title || !terminal || terminal.pinnedTitle !== null) return

        setTabs((current) =>
          current.map((tab) => (tab.id === event.terminalId ? { ...tab, label: title } : tab)),
        )
        const discovered = discoveredSessionsRef.current.get(event.terminalId)
        if (discovered && discovered.pinnedTitle === null) {
          discoveredSessionsRef.current.set(event.terminalId, { ...discovered, title })
        }
        setPayload((current) => {
          if (!current) return current
          let changed = false
          const sessions = current.sessions.map((session) => {
            if (
              session.pinnedTitle !== null ||
              !tabMatchesSession(terminal, session, current.runtime.platform) ||
              session.title === title
            ) {
              return session
            }
            changed = true
            return { ...session, title }
          })
          return changed ? { ...current, sessions } : current
        })
      },
    ).catch((error) => {
      if (!disposed) showError(errorMessage(error, langRef.current))
      return null
    })

    const unlistenRuntime = listen<PtyRuntimeEvent>("pty-runtime", ({ payload: event }) => {
      if (disposed) return
      if (endedRuntimeTerminalIdsRef.current.includes(event.terminalId)) return
      const terminal = tabsRef.current.find((tab) => tab.id === event.terminalId)
      if (
        suppressTransientProxyError(
          pendingProxyErrorsRef.current,
          event,
          terminal?.currentModel,
          proxyProvidersRef.current,
        )
      ) {
        return
      }
      queueRuntimeEvent(event, terminal?.label ?? null)
      const feedback = runtimeEventFeedback(event)
      if (feedback) {
        // Retries repeat the same feedback: coalesce exact repeats, but keep
        // different terminals, roles, fallback edges, and reasons separate.
        pushToast({
          kind: feedback.kind === "fallback" ? "notice" : "error",
          message:
            feedback.kind === "fallback"
              ? t(langRef.current, "fallbackSwitched").replace("{model}", feedback.model)
              : feedback.message,
          dedupeKey: runtimeFeedbackDedupeKey(event, feedback),
        })
      }
      // Tab and incident state are applied together by flushRuntimeEvents.
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, langRef.current))
      return null
    })

    const unlistenUpdate = listen<PtyUpdateEvent>("omp-update-notice", ({ payload: event }) => {
      if (disposed) return
      setUpdateSourceTerminalId(event.terminalId)
      setUpdateInfo((current) =>
        current?.hasUpdate
          ? current
          : {
              hasUpdate: true,
              currentVersion: ompVersionRef.current,
              latestVersion: null,
              message: "",
            },
      )
      if (updateReminderAllowed(event.terminalId)) setUpdateNoticeVisible(true)
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, langRef.current))
      return null
    })

    return () => {
      disposed = true
      if (runtimeFrame !== null) window.cancelAnimationFrame(runtimeFrame)
      runtimeFrame = null
      pendingRuntimeEvents = []
      void unlistenSession.then((stop) => stop?.())
      void unlistenSessionTitle.then((stop) => stop?.())
      void unlistenRuntime.then((stop) => stop?.())
      void unlistenUpdate.then((stop) => stop?.())
    }
  }, [applyPayload, pushToast, showError, updateReminderAllowed])

  const checkForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      const info = await checkOmpUpdate()
      setUpdateInfo((current) => {
        if (!info.hasUpdate && current?.hasUpdate) {
          return current
        }
        return info
      })
      const effectiveHasUpdate = info.hasUpdate || updateInfoRef.current?.hasUpdate === true
      setUpdateNoticeVisible(
        effectiveHasUpdate && updateReminderAllowed(updateSourceTerminalIdRef.current),
      )
    } catch {
      // A live PTY notice remains authoritative when the registry check is temporarily unavailable.
    } finally {
      setCheckingUpdate(false)
    }
  }, [updateReminderAllowed])

  useEffect(() => {
    if (!payload?.runtime.ompAvailable) {
      setUpdateInfo(null)
      setUpdateSourceTerminalId(null)
      setUpdateNoticeVisible(false)
      setCheckingUpdate(false)
      pendingUpdateRestartRef.current = null
      return
    }
    const check = () => void checkForUpdates()
    check()
    const interval = window.setInterval(check, 15 * 60 * 1_000)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") check()
    }
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [
    checkForUpdates,
    payload?.runtime.ompAvailable,
    payload?.runtime.ompVersion,
    updateSourceTerminalId,
  ])

  const selectedWorkspace = useMemo(() => {
    if (!payload || !selectedWorkspaceKey) return null
    return payload.workspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ?? null
  }, [payload, selectedWorkspaceKey])

  useEffect(() => {
    let disposed = false
    setResourceHealth(null)
    setResourceHealthError(null)
    const poll = async () => {
      if (disposed || resourceHealthSamplingRef.current || document.visibilityState !== "visible")
        return
      resourceHealthSamplingRef.current = true
      try {
        const snapshot = await sampleResourceHealth(selectedWorkspace?.path ?? null)
        if (!disposed) {
          setResourceHealth(snapshot)
          setResourceHealthError(null)
        }
      } catch (error) {
        if (!disposed) {
          setResourceHealth(null)
          setResourceHealthError(errorMessage(error, lang))
        }
      } finally {
        resourceHealthSamplingRef.current = false
      }
    }
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void poll()
    }
    void poll()
    const interval = window.setInterval(() => void poll(), 30_000)
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [lang, selectedWorkspace?.path])

  const workspaceSessions = useMemo(() => {
    if (!payload || !selectedWorkspace) return []
    return payload.sessions.filter((session) => session.projectKey === selectedWorkspace.key)
  }, [payload, selectedWorkspace])

  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(localeTag(lang))
    if (!query) return workspaceSessions
    return workspaceSessions.filter((session) =>
      [session.title, session.model ?? "", session.id, session.source]
        .join(" ")
        .toLocaleLowerCase(localeTag(lang))
        .includes(query),
    )
  }, [lang, search, workspaceSessions])

  const selectedSession =
    workspaceSessions.find((session) => session.id === selectedSessionId) ?? null

  const runtimeStatusByTerminal = useMemo<Record<string, RuntimeHealthStatus>>(
    () =>
      Object.fromEntries(
        tabs.map((tab) => [tab.id, runtimeHealthStatus(runtimeIncidentState, tab.id)]),
      ),
    [runtimeIncidentState, tabs],
  )
  const activeRuntimeTerminals = useMemo(
    () => activeRuntimeTerminalCount(runtimeIncidentState),
    [runtimeIncidentState],
  )

  const focusTab = useCallback(
    (tabId: string) => {
      const target = tabs.find((tab) => tab.id === tabId)
      if (!target) return
      setActiveTabId(target.id)
      if (target.sessionId) {
        setSelectedSessionId(target.sessionId)
      }
    },
    [tabs],
  )
  const focusTerminal = useCallback(
    (tabId: string) => {
      if (!tabs.some((tab) => tab.id === tabId)) return
      focusTab(tabId)
      setTerminalFocusRequest((current) => ({
        terminalId: tabId,
        sequence: (current?.sequence ?? 0) + 1,
      }))
    },
    [focusTab, tabs],
  )

  const closeResourceHealth = useCallback(() => setResourceHealthOpen(false), [])
  const closeIncidentCenter = useCallback(() => setIncidentCenterOpen(false), [])
  const openIncidentCenter = useCallback(() => {
    setSettingsOpen(false)
    setCodexOpen(false)
    closeTranscript()
    setResourceHealthOpen(false)
    setIncidentCenterOpen(true)
  }, [closeTranscript])
  const openResourceHealth = useCallback(() => {
    setSettingsOpen(false)
    setCodexOpen(false)
    closeTranscript()
    setIncidentCenterOpen(false)
    setResourceHealthOpen(true)
  }, [closeTranscript])
  const clearResolvedIncidents = useCallback(() => {
    setRuntimeIncidentState((current) => clearResolvedRuntimeIncidents(current, Date.now()))
  }, [])

  const selectSession = useCallback(
    (session: SessionSummary) => {
      setSelectedSessionId(session.id)
      setSearch("")
      const platform = payload?.runtime.platform ?? "windows"
      const target =
        tabs.find((tab) => tab.status === "running" && tabMatchesSession(tab, session, platform)) ??
        tabs.find((tab) => tabMatchesSession(tab, session, platform))
      if (target) {
        focusTab(target.id)
      }
    },
    [focusTab, payload?.runtime.platform, tabs],
  )

  const openFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t(lang, "pickProjectDir"),
      })
      if (typeof selected !== "string") return
      const next = await addWorkspace(selected)
      applyPayload(next, selected)
      setSelectedSessionId(null)
      setSearch("")
    } catch (error) {
      showError(errorMessage(error, lang))
    }
  }, [applyPayload, lang, showError])

  const reveal = useCallback(
    (path: string) => {
      void revealItemInDir(path).catch((error) => showError(errorMessage(error, lang)))
    },
    [lang, showError],
  )

  const launchSession = useCallback(
    async (session?: SessionLaunchTarget, initialInput?: string) => {
      if (!payload || launching !== null) return
      const cwd = session?.cwd ?? selectedWorkspace?.path
      if (!cwd) {
        showError(t(lang, "requireProjectDir"))
        return
      }
      if (!payload.runtime.ompAvailable) {
        setSettingsOpen(true)
        showError(t(lang, "requireOmp"))
        return
      }
      if (session) {
        const platform = payload.runtime.platform
        const existing = tabs.find(
          (tab) => tab.status === "running" && tabMatchesSession(tab, session, platform),
        )
        if (existing) {
          focusTab(existing.id)
          if (initialInput) await queueInitialInput(existing.id, initialInput)
          return
        }
      }
      const launchKey = session?.id ?? "new"
      setLaunching(launchKey)
      try {
        const started = await runWithSessionLeaseReclaim(
          lang,
          "reclaimSessionLeaseConfirm",
          (forceSessionLease) =>
            startTerminal(cwd, session?.filePath ?? null, 120, 36, null, forceSessionLease),
        )
        if (!started) return
        forgetEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, started.terminalId)
        const discoveredSession = discoveredSessionsRef.current.get(started.terminalId) ?? null
        const runtimeSession = session ?? discoveredSession
        const defaultSelector =
          ompConfig?.roles.find((role) => role.role === "default")?.selector ?? ""
        const initialSelector = splitSelector(runtimeSession?.model ?? defaultSelector)
        const initialModel = ompConfig?.models.find((model) =>
          matchesSelector(model, initialSelector.base),
        )
        const initialConfiguredThinking =
          initialSelector.thinking ??
          runtimeSession?.configuredThinkingLevel ??
          runtimeSession?.thinkingLevel ??
          ompConfig?.defaultThinkingLevel ??
          null
        const initialThinking = runtimeSession?.thinkingLevel ?? initialConfiguredThinking
        const tab: TerminalTab = {
          id: started.terminalId,
          label:
            runtimeSession?.title ??
            `${lang === "en" ? "New" : "Новая"} · ${selectedWorkspace?.name ?? "OMP"}`,
          pinnedTitle: runtimeSession?.pinnedTitle ?? null,
          cwd: started.cwd,
          processId: started.processId,
          sessionId: session?.id ?? discoveredSession?.id ?? null,
          sessionPath: session?.filePath ?? discoveredSession?.filePath ?? null,
          status: "running",
          activity: "idle",
          exitCode: null,
          kind: "agent",
          switching: false,
          switchRecovery: null,
          currentModel: initialModel
            ? splitSelector(initialModel.selector).base
            : initialSelector.base || undefined,
          currentModelRole: null,
          currentThinking: initialThinking,
          currentThinkingConfigured: initialConfiguredThinking,
          primaryProviderPinned: runtimeSession?.primaryProviderPinned ?? false,
          primaryProviderPinPending: false,
          success: null,
        }
        if (initialInput) pendingInitialInputRef.current.set(tab.id, initialInput)
        setTabs((current) => [...current, tab])
        setActiveTabId(tab.id)
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setLaunching(null)
      }
    },
    [
      focusTab,
      lang,
      launching,
      ompConfig,
      payload,
      queueInitialInput,
      selectedWorkspace,
      showError,
      tabs,
    ],
  )

  const openAndRereadSession = useCallback(
    async (session: SessionSummary) => {
      const prompt = `${t(lang, "transcriptRereadPrompt").replace("{path}", session.filePath)}\r`
      await launchSession(session, prompt)
      closeTranscript()
    },
    [closeTranscript, lang, launchSession],
  )

  const launchUpdate = useCallback(async () => {
    if (!payload?.runtime.ompAvailable || !selectedWorkspace?.path || launching !== null) return
    const sourceTab =
      tabs.find((tab) => tab.id === updateSourceTerminalId && tab.status === "running") ??
      tabs.find((tab) => tab.status === "running" && tab.kind === "agent") ??
      null
    pendingUpdateRestartRef.current = null
    setLaunching("update")
    try {
      const started = await startTerminal(selectedWorkspace.path, null, 120, 36, ["update"])
      forgetEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, started.terminalId)
      pendingUpdateRestartRef.current = {
        updateTerminalId: started.terminalId,
        sourceTab,
      }
      const tab: TerminalTab = {
        id: started.terminalId,
        label: t(lang, "updateTabTitle"),
        pinnedTitle: null,
        cwd: started.cwd,
        processId: started.processId,
        sessionId: null,
        sessionPath: null,
        status: "running",
        activity: "thinking",
        exitCode: null,
        success: null,
        kind: "utility",
        switching: false,
        switchRecovery: null,
        primaryProviderPinned: false,
        primaryProviderPinPending: false,
      }
      setTabs((current) => [...current, tab])
      setActiveTabId(tab.id)
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      setLaunching(null)
    }
  }, [
    lang,
    launching,
    payload?.runtime.ompAvailable,
    selectedWorkspace?.path,
    showError,
    tabs,
    updateSourceTerminalId,
  ])

  const openCodexImport = useCallback(async () => {
    setCodexOpen(true)
    setCodexLoading(true)
    setImportMode("skip")
    try {
      const sessions = await listCodexSessions()
      setCodexSessions(sessions)
      setCodexSelected({})
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      setCodexLoading(false)
    }
  }, [lang, showError])

  const importCodexSelected = useCallback(async () => {
    if (!selectedWorkspace?.path) {
      showError(t(lang, "requireProjectDir"))
      return
    }
    const selected = codexSessions.filter((session) => codexSelected[session.filePath])
    if (selected.length === 0) return
    setImporting(true)
    try {
      const result = await importSessions(
        selected.map((session) => ({
          path: session.filePath,
          targetCwd: selectedWorkspace.path,
          mode: importMode,
        })),
      )
      applyPayload(result.bootstrap, selectedWorkspace.path)
      const failures = result.items.filter((item) => item.status === "failed")
      showNotice(summarizeImport(result.items, lang))
      if (failures.length > 0) {
        showError(failures.map((item) => item.message ?? item.sourcePath).join("\n"))
      } else {
        setCodexOpen(false)
      }
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      setImporting(false)
    }
  }, [
    applyPayload,
    codexSelected,
    codexSessions,
    importMode,
    lang,
    selectedWorkspace?.path,
    showError,
    showNotice,
  ])

  const importOmpFile = useCallback(async () => {
    if (!selectedWorkspace?.path) {
      showError(t(lang, "requireProjectDir"))
      return
    }
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "Session", extensions: ["jsonl"] }],
        title: t(lang, "importSession"),
      })
      if (typeof selected !== "string") return
      setImportMode("skip")
      setPendingOmpImportPath(selected)
    } catch (error) {
      showError(errorMessage(error, lang))
    }
  }, [lang, selectedWorkspace?.path, showError])

  const importPendingOmp = useCallback(async () => {
    if (!pendingOmpImportPath || !selectedWorkspace?.path) return
    setImporting(true)
    try {
      const result = await importSessions([
        {
          path: pendingOmpImportPath,
          targetCwd: selectedWorkspace.path,
          mode: importMode,
        },
      ])
      applyPayload(result.bootstrap, selectedWorkspace.path)
      const failure = result.items.find((item) => item.status === "failed")
      showNotice(summarizeImport(result.items, lang))
      if (failure) {
        showError(failure.message ?? failure.sourcePath)
      } else {
        setPendingOmpImportPath(null)
      }
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      setImporting(false)
    }
  }, [
    applyPayload,
    importMode,
    lang,
    pendingOmpImportPath,
    selectedWorkspace?.path,
    showError,
    showNotice,
  ])

  const switchTerminalRuntime = useCallback(
    async (terminalId: string, model: string, thinking: string | null) => {
      const tab = tabs.find((candidate) => candidate.id === terminalId)
      if (
        !tab ||
        tab.kind !== "agent" ||
        tab.status !== "running" ||
        tab.switching ||
        tab.switchRecovery
      ) {
        return
      }
      const targetModel = ompConfig?.models.find((candidate) => matchesSelector(candidate, model))

      setTabs((current) =>
        current.map((candidate) =>
          candidate.id === terminalId ? { ...candidate, switching: true } : candidate,
        ),
      )
      try {
        const runtime = await switchTerminal(
          terminalId,
          model,
          thinking,
          thinkingOptionsForModel(targetModel),
          tab.currentModel ?? null,
          tab.currentThinking ?? null,
          tab.currentThinkingConfigured ?? tab.currentThinking ?? null,
        )
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId
              ? {
                  ...candidate,
                  switching: false,
                  switchRecovery: null,
                  currentModel: runtime.model,
                  currentModelRole: runtime.modelRole,
                  currentThinking: runtime.thinkingLevel,
                  currentThinkingConfigured: runtime.configuredThinkingLevel,
                }
              : candidate,
          ),
        )
        void refresh()
      } catch (error) {
        const recovery = switchInputRecoveryDetails(error)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId
              ? { ...candidate, switching: false, switchRecovery: recovery }
              : candidate,
          ),
        )
        if (!recovery) showError(errorMessage(error, lang))
      }
    },
    [lang, ompConfig, refresh, showError, tabs],
  )

  const sendRecoveredSwitchInput = useCallback(
    async (terminalId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === terminalId)
      const recovery = tab?.switchRecovery
      if (!recovery || recovery.state !== "pending") return
      const accepted = await confirm(
        t(lang, "switchRecoverySendConfirm").replace("{count}", String(recovery.byteCount)),
        { title: t(lang, "switchRecoveryTitle"), kind: "warning" },
      )
      if (!accepted) return

      setTabs((current) =>
        current.map((candidate) =>
          candidate.id === terminalId && candidate.switchRecovery?.token === recovery.token
            ? {
                ...candidate,
                switchRecovery: { ...candidate.switchRecovery, state: "sending" },
              }
            : candidate,
        ),
      )
      try {
        await sendSwitchInputRecovery(terminalId, recovery.generation, recovery.token)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId ? { ...candidate, switchRecovery: null } : candidate,
          ),
        )
        focusTerminal(terminalId)
      } catch (error) {
        const currentRecovery = switchInputRecoveryDetails(error)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId
              ? {
                  ...candidate,
                  switchRecovery: currentRecovery ?? candidate.switchRecovery,
                }
              : candidate,
          ),
        )
        showError(errorMessage(error, lang))
      }
    },
    [focusTerminal, lang, showError],
  )

  const discardRecoveredSwitchInput = useCallback(
    async (terminalId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === terminalId)
      const recovery = tab?.switchRecovery
      if (!recovery || recovery.state === "sending") return
      try {
        await discardSwitchInputRecovery(terminalId, recovery.generation, recovery.token)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId ? { ...candidate, switchRecovery: null } : candidate,
          ),
        )
        focusTerminal(terminalId)
      } catch (error) {
        const currentRecovery = switchInputRecoveryDetails(error)
        if (currentRecovery) {
          setTabs((current) =>
            current.map((candidate) =>
              candidate.id === terminalId
                ? { ...candidate, switchRecovery: currentRecovery }
                : candidate,
            ),
          )
        }
        showError(errorMessage(error, lang))
      }
    },
    [focusTerminal, lang, showError],
  )

  const togglePrimaryProviderPin = useCallback(
    async (terminalId: string, pinned: boolean) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === terminalId)
      if (
        !tab ||
        tab.kind !== "agent" ||
        tab.status !== "running" ||
        tab.activity === "thinking" ||
        tab.sessionPath === null ||
        tab.switching ||
        tab.switchRecovery ||
        tab.primaryProviderPinPending ||
        tab.primaryProviderPinned === pinned
      ) {
        return
      }

      restartingTerminalIdsRef.current.add(terminalId)
      restartExitEventsRef.current.delete(terminalId)
      setTabs((current) =>
        current.map((candidate) =>
          candidate.id === terminalId
            ? { ...candidate, primaryProviderPinPending: true }
            : candidate,
        ),
      )

      try {
        const started = await setTerminalPrimaryProviderPin(terminalId, pinned)
        restartingTerminalIdsRef.current.delete(terminalId)
        restartExitEventsRef.current.delete(terminalId)
        forgetTerminalContinuity(terminalId)
        rememberEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, terminalId)
        forgetEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, started.terminalId)

        const discoveredSession = discoveredSessionsRef.current.get(terminalId)
        discoveredSessionsRef.current.delete(terminalId)
        if (discoveredSession) {
          discoveredSessionsRef.current.set(started.terminalId, {
            ...discoveredSession,
            primaryProviderPinned: pinned,
          })
        }
        const pendingInput = pendingInitialInputRef.current.get(terminalId)
        pendingInitialInputRef.current.delete(terminalId)
        if (pendingInput) pendingInitialInputRef.current.set(started.terminalId, pendingInput)
        readyTerminalIdsRef.current.delete(terminalId)
        completionNotifiedRef.current.delete(terminalId)
        completionNotifiedRef.current.delete(started.terminalId)

        setTabs((current) =>
          current.map((candidate) =>
            replaceTerminalAfterRestart(candidate, terminalId, started, pinned),
          ),
        )
        setActiveTabId((current) => (current === terminalId ? started.terminalId : current))
        setTerminalFocusRequest((current) =>
          current?.terminalId === terminalId
            ? { ...current, terminalId: started.terminalId }
            : current,
        )
        setUpdateSourceTerminalId((current) =>
          current === terminalId ? started.terminalId : current,
        )
        void refresh()
      } catch (error) {
        restartingTerminalIdsRef.current.delete(terminalId)
        const exitEvent = restartExitEventsRef.current.get(terminalId)
        const stopped =
          exitEvent !== undefined || backendErrorCode(error) === "terminal_restart_stopped"
        restartExitEventsRef.current.delete(terminalId)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId
              ? {
                  ...candidate,
                  primaryProviderPinPending: false,
                  ...(stopped
                    ? {
                        activity: "idle" as const,
                        status: "exited" as const,
                        exitCode: exitEvent?.exitCode ?? null,
                        success: exitEvent?.success ?? false,
                        switching: false,
                        switchRecovery: null,
                      }
                    : {}),
                }
              : candidate,
          ),
        )
        showError(errorMessage(error, langRef.current))
      }
    },
    [refresh, showError],
  )

  const handleReorderTabs = useCallback((draggedId: string, targetId: string) => {
    setTabs((current) => {
      const draggedIndex = current.findIndex((tab) => tab.id === draggedId)
      const targetIndex = current.findIndex((tab) => tab.id === targetId)
      if (draggedIndex < 0 || targetIndex < 0) return current
      const copy = [...current]
      const [moved] = copy.splice(draggedIndex, 1)
      copy.splice(targetIndex, 0, moved)
      return copy
    })
  }, [])

  const performCloseTab = useCallback(
    (terminalId: string) => {
      forgetTerminalContinuity(terminalId)
      rememberEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, terminalId)
      setRuntimeIncidentState((current) =>
        endRuntimeIncidentTerminal(current, terminalId, Date.now()),
      )
      if (pendingUpdateRestartRef.current?.updateTerminalId === terminalId) {
        pendingUpdateRestartRef.current = null
      }
      pendingInitialInputRef.current.delete(terminalId)
      readyTerminalIdsRef.current.delete(terminalId)
      discoveredSessionsRef.current.delete(terminalId)
      pendingProxyErrorsRef.current.delete(terminalId)
      completionNotifiedRef.current.delete(terminalId)
      restartingTerminalIdsRef.current.delete(terminalId)
      restartExitEventsRef.current.delete(terminalId)
      void closeTerminal(terminalId)
        .then(() => refresh())
        .catch((error) => showError(errorMessage(error, lang)))
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === terminalId)
        const remaining = current.filter((tab) => tab.id !== terminalId)
        setActiveTabId((active) => {
          if (active !== terminalId) return active
          return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null
        })
        return remaining
      })
    },
    [lang, refresh, showError],
  )

  const closeTab = useCallback(
    (terminalId: string) => {
      const target = tabs.find((tab) => tab.id === terminalId)
      if (!target || target.switching || target.primaryProviderPinPending) return
      if (target.status === "running") {
        void confirm(t(lang, "stopAndCloseConfirm"), {
          title: target.label,
          kind: "warning",
        }).then((shouldClose) => {
          if (shouldClose) {
            performCloseTab(terminalId)
          }
        })
      } else {
        performCloseTab(terminalId)
      }
    },
    [lang, performCloseTab, tabs],
  )

  useEffect(() => {
    const pending = pendingUpdateRestartRef.current
    if (!pending) return
    const updateTab = tabs.find((tab) => tab.id === pending.updateTerminalId)
    // Only clear if the tab existed but is no longer a running utility tab.
    // Do NOT clear if the tab hasn't been registered yet (race between setTabs and ref write).
    if (updateTab && (updateTab.kind !== "utility" || updateTab.status !== "running")) {
      pendingUpdateRestartRef.current = null
    }
  }, [tabs])

  const deleteOmpSession = useCallback(
    async (session: SessionSummary) => {
      const platform = payload?.runtime.platform ?? "windows"
      const matchingTabs = tabs.filter((tab) => tabMatchesSession(tab, session, platform))
      if (matchingTabs.some((tab) => tab.status === "running")) {
        showError(t(lang, "closeSessionBeforeDelete"))
        return
      }
      try {
        const accepted = await confirm(
          t(lang, "deleteSessionConfirm").replace("{title}", session.title),
          { title: t(lang, "deleteSession"), kind: "warning" },
        )
        if (!accepted) return
        setDeletingSessionId(session.id)
        const next = await runWithSessionLeaseReclaim(
          lang,
          "reclaimSessionLeaseDeleteConfirm",
          (forceSessionLease) => deleteSession(session.filePath, forceSessionLease),
        )
        if (!next) return
        for (const tab of matchingTabs) closeTab(tab.id)
        applyPayload(next, selectedWorkspace?.path)
        showNotice(t(lang, "sessionDeleted"))
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setDeletingSessionId(null)
      }
    },
    [
      applyPayload,
      closeTab,
      lang,
      payload?.runtime.platform,
      selectedWorkspace?.path,
      showError,
      showNotice,
      tabs,
    ],
  )

  const updateSessionTitlePin = useCallback(
    async (session: SessionSummary, title: string | null) => {
      try {
        applyPayload(await setSessionTitlePin(session.filePath, title))
      } catch (error) {
        showError(errorMessage(error, lang))
      }
    },
    [applyPayload, lang, showError],
  )

  const startRenameSession = useCallback((session: SessionSummary) => {
    setRenameValue(session.title)
    setRenamingSessionId(session.id)
  }, [])

  const toggleSessionTitlePin = useCallback(
    (session: SessionSummary) => {
      void updateSessionTitlePin(session, session.pinnedTitle ? null : session.title)
    },
    [updateSessionTitlePin],
  )

  const submitRenameSession = useCallback(
    (session: SessionSummary) => {
      if (renamingSessionId !== session.id) return
      setRenamingSessionId(null)
      const trimmed = renameValue.trim()
      if (trimmed) void updateSessionTitlePin(session, trimmed)
    },
    [renameValue, renamingSessionId, updateSessionTitlePin],
  )

  const toggleTabTitlePin = useCallback(
    (tab: TerminalTab) => {
      if (!payload) return
      const session = payload.sessions.find((candidate) =>
        tabMatchesSession(tab, candidate, payload.runtime.platform),
      )
      if (session) toggleSessionTitlePin(session)
    },
    [payload, toggleSessionTitlePin],
  )

  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, session: SessionSummary) => {
      if (event.key === "Enter") {
        event.preventDefault()
        submitRenameSession(session)
      } else if (event.key === "Escape") {
        event.preventDefault()
        setRenamingSessionId(null)
      }
    },
    [submitRenameSession],
  )

  const handleExit = useCallback(
    (event: PtyExitEvent) => {
      rememberEndedRuntimeTerminal(endedRuntimeTerminalIdsRef.current, event.terminalId)
      setRuntimeIncidentState((current) =>
        endRuntimeIncidentTerminal(current, event.terminalId, Date.now()),
      )
      if (restartingTerminalIdsRef.current.has(event.terminalId)) {
        restartExitEventsRef.current.set(event.terminalId, event)
        pendingInitialInputRef.current.delete(event.terminalId)
        readyTerminalIdsRef.current.delete(event.terminalId)
        return
      }
      if (completionNotifiedRef.current.has(event.terminalId)) return
      completionNotifiedRef.current.add(event.terminalId)
      pendingInitialInputRef.current.delete(event.terminalId)
      readyTerminalIdsRef.current.delete(event.terminalId)
      const pendingUpdate =
        pendingUpdateRestartRef.current?.updateTerminalId === event.terminalId
          ? pendingUpdateRestartRef.current
          : null
      if (pendingUpdate) pendingUpdateRestartRef.current = null

      const target = tabs.find((tab) => tab.id === event.terminalId)
      setTabs((current) =>
        current.map((tab) =>
          tab.id === event.terminalId
            ? {
                ...tab,
                activity: "idle",
                status: "exited",
                exitCode: event.exitCode,
                success: event.success,
                switching: false,
                switchRecovery: null,
              }
            : tab,
        ),
      )

      const viewingCompletedTab =
        activeTabId === event.terminalId &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      if (target?.kind === "agent" && !viewingCompletedTab) {
        void notifyTerminalCompletion(target, event, lang)
      }

      if (event.success) {
        if (pendingUpdate) {
          setUpdateInfo(null)
          setUpdateSourceTerminalId(null)
          setUpdateNoticeVisible(false)
          clearUpdateReminderTimer()
          ignoredUpdateReminderKeysRef.current.clear()
          persistUpdateReminderSnooze(0)
          updateReminderSnoozedUntilRef.current = 0
          showNotice(t(lang, "updateInstalled"))
          if (pendingUpdate.sourceTab?.sessionId && pendingUpdate.sourceTab.sessionPath) {
            const targetSession: SessionLaunchTarget = {
              id: pendingUpdate.sourceTab.sessionId,
              title: pendingUpdate.sourceTab.label,
              pinnedTitle: pendingUpdate.sourceTab.pinnedTitle,
              cwd: pendingUpdate.sourceTab.cwd,
              filePath: pendingUpdate.sourceTab.sessionPath,
              model: pendingUpdate.sourceTab.currentModel ?? null,
              thinkingLevel: pendingUpdate.sourceTab.currentThinking ?? null,
              configuredThinkingLevel: pendingUpdate.sourceTab.currentThinkingConfigured ?? null,
              primaryProviderPinned: pendingUpdate.sourceTab.primaryProviderPinned,
            }
            showNotice(t(lang, "updateRestarted").replace("{title}", pendingUpdate.sourceTab.label))
            void launchSession(targetSession)
          }
        }
        void checkForUpdates()
        void refresh()
      }
    },
    [
      activeTabId,
      checkForUpdates,
      clearUpdateReminderTimer,
      lang,
      launchSession,
      refresh,
      showNotice,
      tabs,
    ],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && transcriptSession) {
        event.preventDefault()
        closeTranscript()
        return
      }
      if (
        incidentCenterOpen ||
        resourceHealthOpen ||
        settingsOpen ||
        codexOpen ||
        transcriptSession
      )
        return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.shiftKey && event.code === "KeyO") {
        event.preventDefault()
        void openFolder()
      } else if (modifier && !event.shiftKey && event.code === "KeyB") {
        event.preventDefault()
        if (railMode === "autoHide") {
          if (railAutoOpen) focusPersistentRailControl()
          setRailAutoOpen((current) => !current)
        } else {
          if (railMode === "expanded") focusPersistentRailControl()
          void changeRailMode(railMode === "expanded" ? "collapsed" : "expanded")
        }
      } else if (modifier && event.code === "KeyN") {
        event.preventDefault()
        void launchSession()
      } else if (modifier && event.code === "KeyW" && activeTabId) {
        event.preventDefault()
        closeTab(activeTabId)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    activeTabId,
    changeRailMode,
    closeTab,
    closeTranscript,
    codexOpen,
    focusPersistentRailControl,
    incidentCenterOpen,
    launchSession,
    openFolder,
    railMode,
    railAutoOpen,
    resourceHealthOpen,
    settingsOpen,
    transcriptSession,
  ])

  if (settingsRecovery) {
    return (
      <SettingsRecoveryScreen
        busy={settingsRecoveryBusy || refreshing}
        language={lang}
        recovery={settingsRecovery}
        onOpenFolder={() => void openSettingsRecoveryFolder()}
        onRetry={() => void refresh()}
        onStartWithDefaults={() => void recoverSettingsWithDefaults()}
      />
    )
  }

  if (!payload) {
    return (
      <main className="splash-screen">
        <div className="splash-logo">
          <Icon name="logo" size={58} />
        </div>
        <h1>OMP Desktop</h1>
        {refreshing ? (
          <p>
            <span className="loading-dot" /> {t("ru", "loading")}
          </p>
        ) : (
          <>
            <p className="splash-error">{startupError ?? t("ru", "loadError")}</p>
            <button className="button primary" onClick={() => void refresh()} type="button">
              <Icon name="refresh" /> {t("ru", "retry")}
            </button>
          </>
        )}
      </main>
    )
  }

  return (
    <div className="app-shell" style={{ fontFamily: payload.settings.appFontFamily }}>
      <Topbar
        appVersion={appVersion}
        checkingUpdate={checkingUpdate}
        incidentActiveTerminalCount={activeRuntimeTerminals}
        incidentCenterOpen={incidentCenterOpen}
        incidentTriggerRef={incidentCenterTriggerRef}
        language={lang}
        resourceHealth={resourceHealth}
        resourceHealthOpen={resourceHealthOpen}
        resourceTriggerRef={resourceHealthTriggerRef}
        onOpenIncidentCenter={openIncidentCenter}
        onOpenResourceHealth={openResourceHealth}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={() => void refresh()}
        onUpdate={() => void launchUpdate()}
        refreshing={refreshing}
        runtime={payload.runtime}
        selectedWorkspace={selectedWorkspace}
        updateInfo={updateInfo}
      />

      <div className={`workbench rail-${railMode === "autoHide" ? "auto-hide" : railMode}`}>
        <ProjectRail
          autoOpen={railAutoOpen}
          mode={railMode}
          modeSaving={railModeSaving}
          onAutoOpenChange={setRailAutoOpen}
          onModeChange={(mode) => void changeRailMode(mode)}
          onOpenFolder={() => void openFolder()}
          onSelectWorkspace={(key) => {
            setSelectedWorkspaceKey(key)
            setSelectedSessionId(null)
            setSearch("")
          }}
          selectedWorkspace={selectedWorkspace}
          renamingWorkspaceKey={renamingWorkspaceKey}
          workspaceBusyKey={workspaceBusyKey}
          workspaceNameValue={workspaceNameValue}
          onRemoveWorkspace={(workspace) => void removeWorkspace(workspace)}
          onStartWorkspaceRename={startWorkspaceRename}
          onSubmitWorkspaceRename={(workspace) => void submitWorkspaceRename(workspace)}
          onWorkspaceNameChange={setWorkspaceNameValue}
          onWorkspaceRenameKeyDown={handleWorkspaceRenameKeyDown}
          sessionList={{
            canLaunch: payload.runtime.ompAvailable,
            allSessions: workspaceSessions,
            deletingSessionId,
            lang,
            launching,
            onClearSearch: () => setSearch(""),
            onDeleteSession: (session) => void deleteOmpSession(session),
            onImportOmp: () => void importOmpFile(),
            onLaunchSession: (session) => void launchSession(session),
            onLoadTranscript: (session) => void loadTranscript(session),
            onNewSession: () => void launchSession(),
            onOpenCodex: () => void openCodexImport(),
            onRenameKeyDown: handleRenameKeyDown,
            onRenameValueChange: setRenameValue,
            onRevealWorkspace: reveal,
            onSearchChange: setSearch,
            onSelectSession: selectSession,
            onStartRename: startRenameSession,
            onSubmitRename: submitRenameSession,
            onToggleTitlePin: toggleSessionTitlePin,
            platform: payload.runtime.platform,
            renameValue,
            renamingSessionId,
            search,
            selectedSessionId,
            selectedWorkspaceName: selectedWorkspace?.name ?? null,
            selectedWorkspacePath: selectedWorkspace?.path ?? null,
            tabs,
            visibleSessions,
            workspaceSessionsCount: workspaceSessions.length,
          }}
          workspaces={payload.workspaces}
        />
        <TerminalWorkspace
          activeTabId={activeTabId}
          focusRequest={terminalFocusRequest}
          language={lang}
          terminalFontFamily={payload.settings.terminalFontFamily}
          terminalFontSize={payload.settings.terminalFontSize}
          launching={launching}
          ompConfig={ompConfig}
          onDiscardSwitchRecovery={(terminalId) => void discardRecoveredSwitchInput(terminalId)}
          onCloseTab={closeTab}
          onError={showError}
          onExit={handleExit}
          onFocusTab={focusTab}
          onLaunch={(session) => void launchSession(session)}
          onOpenFolder={() => void openFolder()}
          onReorderTabs={handleReorderTabs}
          onReady={handleTerminalReady}
          onSendSwitchRecovery={(terminalId) => void sendRecoveredSwitchInput(terminalId)}
          onReveal={reveal}
          onSwitch={(tabId, model, thinking) => void switchTerminalRuntime(tabId, model, thinking)}
          onTogglePrimaryProviderPin={(terminalId, pinned) =>
            void togglePrimaryProviderPin(terminalId, pinned)
          }
          onToggleTitlePin={toggleTabTitlePin}
          runtime={payload.runtime}
          runtimeStatusByTerminal={runtimeStatusByTerminal}
          selectedSession={selectedSession}
          selectedWorkspace={selectedWorkspace}
          tabs={tabs}
          workspaceSessions={workspaceSessions}
        />
      </div>

      {resourceHealthOpen && (
        <ResourceHealthPanel
          error={resourceHealthError}
          language={lang}
          onClose={closeResourceHealth}
          returnFocusRef={resourceHealthTriggerRef}
          snapshot={resourceHealth}
        />
      )}

      {incidentCenterOpen && (
        <IncidentCenter
          incidents={runtimeIncidentState.incidents}
          language={lang}
          onClearResolved={clearResolvedIncidents}
          onClose={closeIncidentCenter}
          onFocusTerminal={focusTerminal}
          returnFocusRef={incidentCenterTriggerRef}
          tabs={tabs}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onConfigSaved={setOmpConfig}
          onError={showError}
          onSaved={applyPayload}
          runtime={payload.runtime}
          settings={payload.settings}
        />
      )}

      {transcriptSession && (
        <TranscriptModal
          lang={lang}
          launching={launching}
          onClearSearch={() => setTranscriptSearch("")}
          onClose={closeTranscript}
          onModeChange={setTranscriptMode}
          onRefresh={() => void loadTranscript(transcriptSession)}
          onReread={() => void openAndRereadSession(transcriptSession)}
          onSearchChange={setTranscriptSearch}
          runtimeAvailable={payload.runtime.ompAvailable}
          transcript={transcript}
          transcriptError={transcriptError}
          transcriptLoading={transcriptLoading}
          transcriptMode={transcriptMode}
          transcriptSearch={transcriptSearch}
          transcriptSession={transcriptSession}
          visibleEntries={visibleTranscriptEntries}
        />
      )}

      {codexOpen && (
        <CodexImportModal
          importing={importing}
          language={lang}
          loading={codexLoading}
          mode={importMode}
          onClose={() => {
            if (!importing) setCodexOpen(false)
          }}
          onImport={() => void importCodexSelected()}
          onModeChange={setImportMode}
          onSelectedChange={setCodexSelected}
          selected={codexSelected}
          sessions={codexSessions}
        />
      )}

      {pendingOmpImportPath && (
        <ImportSessionModal
          importing={importing}
          language={lang}
          mode={importMode}
          onClose={() => {
            if (!importing) setPendingOmpImportPath(null)
          }}
          onImport={() => void importPendingOmp()}
          onModeChange={setImportMode}
          path={pendingOmpImportPath}
        />
      )}

      {updateNoticeVisible && updateInfo?.hasUpdate && (
        <UpdateNotice
          disabled={launching !== null}
          info={updateInfo}
          language={lang}
          onDismissSession={updateSourceTerminalId ? dismissUpdateForSession : undefined}
          onRemindLater={remindUpdateLater}
          onUpdate={() => void launchUpdate()}
        />
      )}

      {clientUpdate && (
        <ClientUpdateNotice
          info={clientUpdate}
          installing={installingClientUpdate}
          language={lang}
          onClose={dismissClientUpdate}
          onInstall={() => void installAvailableClientUpdate()}
        />
      )}

      <ToastContainer language={lang} onDismiss={dismissToast} toasts={toastState.items} />
    </div>
  )
}

export default App

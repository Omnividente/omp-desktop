import { createPortal } from "react-dom"
import { StartupWorkspaceRecovery } from "./StartupWorkspaceRecovery"
import type { StartupWorkspaceWarning } from "./types"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useDesktopTheme } from "./useDesktopTheme"
import { getVersion } from "@tauri-apps/api/app"
import { listen } from "@tauri-apps/api/event"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import {
  addWorkspace,
  resolveStartupWorkspace,
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
  OMP_CONFIG_STALE_MS,
  type OmpConfigRuntime,
  openSettingsFolder,
  removeWorkspace as removeWorkspaceFromList,
  renameWorkspace,
  sampleResourceHealth,
  saveSettingsBundle,
  saveWorkspaceSelection,
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
import { importFailureMessage } from "./importFailure"
import { IncidentCenter } from "./IncidentCenter"
import { SessionCopyModal } from "./SessionCopyModal"
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
  SettingsSavePayload,
  SingleInstanceEvent,
  TerminalTab,
  WorkspaceSummary,
} from "./types"
import {
  localeTag,
  mergeSessionIntoPayload,
  normalizedPath,
  replaceTerminalAfterRestart,
  reorderTerminalTabs,
  tabMatchesSession,
} from "./uiUtils"
import { useClientUpdater } from "./useClientUpdater"
import { useWindowActivity } from "./useWindowActivity"
import { useTranscript } from "./useTranscript"
import packageMetadata from "../package.json"
import "./App.css"

const OMP_RELEASE_NOTES_URL = "https://github.com/can1357/oh-my-pi/releases/tag/"
const DESKTOP_RELEASE_NOTES_URL = "https://github.com/Omnividente/omp-desktop/releases/tag/"

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
  const mountedRef = useRef(false)
  const payloadRevisionRef = useRef(0)
  const refreshRequestRef = useRef(0)
  useEffect(() => {
    ++refreshRequestRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const proxyProvidersRef = useRef<readonly string[]>([])
  proxyProvidersRef.current = payload?.settings.proxyProviders ?? []
  const [appVersion, setAppVersion] = useState(packageMetadata.version)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null)
  const workspaceSelectionRequestRef = useRef(0)
  const workspaceSaveQueueRef = useRef<Promise<void> | null>(null)
  const workspaceSaveRequestRef = useRef(0)
  const [workspaceSaveRetry, setWorkspaceSaveRetry] = useState(0)
  const [workspaceSaveFailure, setWorkspaceSaveFailure] = useState<{
    path: string | null
    message: string
  } | null>(null)
  const [workspaceSaveBusy, setWorkspaceSaveBusy] = useState(false)
  const workspaceSaveRetryPendingRef = useRef(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const sessionSelectionRequestRef = useRef(0)
  const [search, setSearch] = useState("")
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const unpublishedTerminalIdsRef = useRef(new Set<string>())
  useLayoutEffect(() => {
    const unpublished = unpublishedTerminalIdsRef.current
    if (unpublished.size === 0) return
    // A spawned process remains guarded until its tab reaches the committed tree.
    for (const tab of tabs) unpublished.delete(tab.id)
  }, [tabs])
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
  const launchingRef = useRef(false)
  const [settingsOpenedAt, setSettingsOpenedAt] = useState<number | null>(null)
  const settingsOpen = settingsOpenedAt !== null
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupWorkspaceWarning, setStartupWorkspaceWarning] =
    useState<StartupWorkspaceWarning | null>(null)
  const startupWorkspaceWarningRef = useRef<StartupWorkspaceWarning | null>(null)
  const [startupWorkspaceBusy, setStartupWorkspaceBusy] = useState(false)
  const startupWorkspaceBusyRef = useRef(false)
  const [startupWorkspaceError, setStartupWorkspaceError] = useState<string | null>(null)
  const acceptStartupWorkspaceWarning = useCallback((warning: StartupWorkspaceWarning | null) => {
    startupWorkspaceWarningRef.current = warning
    setStartupWorkspaceWarning(warning)
  }, [])

  const [settingsRecovery, setSettingsRecovery] = useState<SettingsUnavailableDetails | null>(null)
  const settingsRecoveryRef = useRef<SettingsUnavailableDetails | null>(null)
  const [settingsRecoveryBusy, setSettingsRecoveryBusy] = useState(false)
  const [settingsRecoveryActionError, setSettingsRecoveryActionError] = useState<string | null>(
    null,
  )
  const [settingsRecoveryRefreshError, setSettingsRecoveryRefreshError] = useState<string | null>(
    null,
  )
  const settingsRecoveryActionRef = useRef<{
    request: number
    active: number | null
  }>({ request: 0, active: null })
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const sessionRenameRequestRef = useRef(0)
  const sessionRenamePendingRef = useRef<number | null>(null)
  const [renamingWorkspaceKey, setRenamingWorkspaceKey] = useState<string | null>(null)
  const [workspaceNameValue, setWorkspaceNameValue] = useState("")
  const workspaceRenameRequestRef = useRef(0)
  const workspaceRenamePendingRef = useRef<number | null>(null)
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
  const [codexFailures, setCodexFailures] = useState<Record<string, string>>({})
  const codexViewRef = useRef(0)
  const codexContextRef = useRef<{ open: boolean; path: string | null | undefined }>({
    open: false,
    path: undefined,
  })
  const [codexLoading, setCodexLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMode, setImportMode] = useState<ImportMode>("skip")
  const [ompFilePickerOpen, setOmpFilePickerOpen] = useState(false)
  const copyCloseFocusRef = useRef<{ workspace: number; session: number } | null>(null)
  const [copySession, setCopySession] = useState<{
    session: SessionSummary
    selectionRequest: number
    sessionRequest: number
    payloadRevision: number
  } | null>(null)
  useLayoutEffect(() => {
    const pending = copyCloseFocusRef.current
    if (copySession || !pending) return
    copyCloseFocusRef.current = null
    if (
      pending.workspace !== workspaceSelectionRequestRef.current ||
      pending.session !== sessionSelectionRequestRef.current ||
      document.activeElement !== document.body ||
      document.querySelector('[aria-modal="true"]')
    )
      return
    const targets = [
      document.querySelector<HTMLElement>(".session-item.is-selected .session-select"),
      document.querySelector<HTMLElement>(".project-item.is-active"),
      document.querySelector<HTMLElement>(".rail-open-folder"),
    ]
    for (const target of targets) {
      if (!target) continue
      if (target.matches(":disabled") || target.closest("[hidden], [inert]")) continue
      let visible = true
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        )
          visible = false
      }
      if (!visible) continue
      target.focus({ preventScroll: false })
      if (document.activeElement === target) break
    }
  }, [copySession])
  const [pendingOmpImportPath, setPendingOmpImportPath] = useState<string | null>(null)
  const [resourceHealth, setResourceHealth] = useState<ResourceHealthSnapshot | null>(null)
  const [resourceHealthError, setResourceHealthError] = useState<string | null>(null)
  const [resourceHealthOpen, setResourceHealthOpen] = useState(false)
  const resourceHealthTriggerRef = useRef<HTMLButtonElement>(null)
  const resourceHealthSamplingRef = useRef(false)
  const resourceHealthPendingRefreshRef = useRef<(() => void) | null>(null)
  const [railAutoOpen, setRailAutoOpen] = useState(false)
  const [railModeSaving, setRailModeSaving] = useState(false)

  const [ompConfig, setOmpConfig] = useState<OmpConfigSnapshot | null>(null)
  const [ompConfigError, setOmpConfigError] = useState<string | null>(null)
  const [ompConfigLoading, setOmpConfigLoading] = useState(false)
  const [ompConfigAttempt, setOmpConfigAttempt] = useState(0)
  const ompConfigRequestRef = useRef(0)
  const ompConfigBaselineRef = useRef<{ runtime: OmpConfigRuntime; loadedAt: number } | null>(null)
  const acceptOmpConfig = useCallback((snapshot: OmpConfigSnapshot, runtime: OmpConfigRuntime) => {
    ++ompConfigRequestRef.current
    ompConfigBaselineRef.current = { runtime, loadedAt: Date.now() }
    setOmpConfig(snapshot)
    setOmpConfigError(null)
    setOmpConfigLoading(false)
  }, [])

  useDesktopTheme(payload?.settings.desktopTheme ?? "dark")

  const appFontSize = payload?.settings.appFontSize
  useEffect(() => {
    if (appFontSize === undefined) return
    const root = document.documentElement
    const previousFontSize = root.style.fontSize
    root.style.fontSize = `${appFontSize}px`
    return () => {
      root.style.fontSize = previousFontSize
    }
  }, [appFontSize])

  const lang: Lang = payload?.settings.language === "en" ? "en" : "ru"
  useEffect(() => {
    const root = document.documentElement
    const previousLanguage = root.getAttribute("lang")
    root.lang = lang
    return () => {
      if (previousLanguage === null) root.removeAttribute("lang")
      else root.setAttribute("lang", previousLanguage)
    }
  }, [lang])

  const langRef = useRef(lang)
  langRef.current = lang
  const ompVersionRef = useRef(payload?.runtime.ompVersion ?? null)
  ompVersionRef.current = payload?.runtime.ompVersion ?? null

  const ompAvailable = payload?.runtime.ompAvailable
  const ompExecutable = payload?.runtime.ompExecutable
  const ompVersion = payload?.runtime.ompVersion

  useEffect(() => {
    const request = ++ompConfigRequestRef.current
    let disposed = false
    const current = () => !disposed && request === ompConfigRequestRef.current
    setOmpConfigError(null)
    setOmpConfig(null)
    ompConfigBaselineRef.current = null
    setOmpConfigLoading(Boolean(ompAvailable))
    if (!ompAvailable || ompExecutable === undefined) return
    const runtime = { ompAvailable, ompExecutable, ompVersion: ompVersion ?? null }
    void loadOmpConfig(runtime)
      .then((snapshot) => {
        if (current()) acceptOmpConfig(snapshot, runtime)
      })
      .catch((error) => {
        if (current()) setOmpConfigError(errorMessage(error, langRef.current))
      })
      .finally(() => {
        if (current()) setOmpConfigLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [acceptOmpConfig, ompConfigAttempt, ompAvailable, ompExecutable, ompVersion])
  const railMode = payload?.settings.railMode ?? "expanded"
  const {
    transcriptSession,
    transcript,
    transcriptLoading,
    transcriptError,
    transcriptSearch,
    transcriptMode,
    transcriptInitialPosition,
    visibleEntries: visibleTranscriptEntries,
    loadTranscript,
    loadTranscriptPath,
    closeTranscript,
    setSearch: setTranscriptSearch,
    setMode: setTranscriptMode,
  } = useTranscript(lang)
  const knownSessionPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!payload) return
    const nextPaths = new Set(payload.sessions.map((session) => session.filePath))
    if (
      transcriptSession &&
      knownSessionPathsRef.current.has(transcriptSession.filePath) &&
      !nextPaths.has(transcriptSession.filePath)
    ) {
      closeTranscript()
    }
    knownSessionPathsRef.current = nextPaths
  }, [payload, transcriptSession, closeTranscript])

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

  const readTerminalTranscript = useCallback(
    (path: string) => {
      void loadTranscriptPath(path).catch((error) => showError(errorMessage(error, lang)))
    },
    [lang, loadTranscriptPath, showError],
  )

  const openReleaseNotes = useCallback(
    (baseUrl: string, version: string) => {
      const normalizedVersion = version.trim()
      if (!normalizedVersion) return
      const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`
      void openUrl(`${baseUrl}${encodeURIComponent(tag)}`).catch((error) =>
        showError(errorMessage(error, lang)),
      )
    },
    [lang, showError],
  )

  const showNotice = useCallback(
    (message: string) => pushToast({ kind: "notice", message }),
    [pushToast],
  )

  useEffect(
    () =>
      subscribeSettingsUnavailable((recovery) => {
        ++settingsRecoveryActionRef.current.request
        setSettingsRecoveryActionError(null)
        setSettingsRecoveryRefreshError(null)
        settingsRecoveryRef.current = recovery
        setSettingsRecovery(recovery)
        setStartupError(recovery.message)
        setRefreshing(false)
        setSettingsRecoveryBusy(settingsRecoveryActionRef.current.active !== null)
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
    isInstalling: isInstallingClientUpdate,
    checking: checkingClientUpdate,
    checkNow: checkClientUpdateNow,
    remindLater: remindClientUpdateLater,
    install: installAvailableClientUpdate,
  } = useClientUpdater(lang, showError, showNotice, () => ({
    runningTerminalCount: tabsRef.current.reduce(
      (count, tab) => count + Number(tab.status === "running"),
      0,
    ),
    launching:
      launchingRef.current ||
      unpublishedTerminalIdsRef.current.size > 0 ||
      restartingTerminalIdsRef.current.size > 0 ||
      tabsRef.current.some((tab) => tab.primaryProviderPinPending),
  }))
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
      ++payloadRevisionRef.current
      setPayload(next)
      // Ordinary mutations may omit this add-only field; they cannot dismiss the launch intent.
      if (next.startupWorkspaceWarning) acceptStartupWorkspaceWarning(next.startupWorkspaceWarning)
      settingsRecoveryRef.current = null
      setSettingsRecovery(null)
      ++settingsRecoveryActionRef.current.request
      setSettingsRecoveryBusy(settingsRecoveryActionRef.current.active !== null)
      setSettingsRecoveryActionError(null)
      setSettingsRecoveryRefreshError(null)
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
        const preferred = preferredWorkspace ?? current ?? next.settings.lastWorkspace
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
    [acceptStartupWorkspaceWarning, showNotice],
  )

  const handleSettingsSaved = useCallback(
    (result: SettingsSavePayload) => {
      if (result.ompConfig) {
        acceptOmpConfig(result.ompConfig, result.bootstrap.runtime)
      } else if (
        ompAvailable !== result.bootstrap.runtime.ompAvailable ||
        ompExecutable !== result.bootstrap.runtime.ompExecutable ||
        ompVersion !== result.bootstrap.runtime.ompVersion
      ) {
        ++ompConfigRequestRef.current
        setOmpConfig(null)
        ompConfigBaselineRef.current = null
        setOmpConfigError(null)
        setOmpConfigLoading(result.bootstrap.runtime.ompAvailable)
        setOmpConfigAttempt((attempt) => attempt + 1)
      }
      applyPayload(result.bootstrap)
    },
    [acceptOmpConfig, applyPayload, ompAvailable, ompExecutable, ompVersion],
  )

  const changeRailMode = useCallback(
    async (mode: RailMode) => {
      if (!payload || railModeSaving || mode === payload.settings.railMode) return
      setRailModeSaving(true)
      try {
        const result = await saveSettingsBundle({ update: { railMode: mode }, ompConfig: null })
        applyPayload(result.bootstrap)
        setRailAutoOpen(mode === "autoHide")
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setRailModeSaving(false)
      }
    },
    [applyPayload, lang, payload, railModeSaving, showError],
  )

  const startWorkspaceRename = useCallback((workspace: WorkspaceSummary) => {
    ++workspaceRenameRequestRef.current
    setRenamingWorkspaceKey(workspace.key)
    setWorkspaceNameValue(workspace.name)
  }, [])

  const changeWorkspaceName = useCallback((value: string) => {
    ++workspaceRenameRequestRef.current
    setWorkspaceNameValue(value)
  }, [])

  const submitWorkspaceRename = useCallback(
    async (workspace: WorkspaceSummary) => {
      if (renamingWorkspaceKey !== workspace.key || workspaceBusyKey === workspace.key) return
      const name = workspaceNameValue.trim()
      const request = workspaceRenameRequestRef.current
      if (workspaceRenamePendingRef.current === request) return
      if (!name || name === workspace.name) {
        setRenamingWorkspaceKey(null)
        setWorkspaceNameValue("")
        return
      }
      workspaceRenamePendingRef.current = request
      setWorkspaceBusyKey(workspace.key)
      try {
        applyPayload(await renameWorkspace(workspace.path, name))
        if (request === workspaceRenameRequestRef.current) {
          setRenamingWorkspaceKey(null)
          setWorkspaceNameValue("")
        }
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        if (workspaceRenamePendingRef.current === request) workspaceRenamePendingRef.current = null
        setWorkspaceBusyKey((current) => (current === workspace.key ? null : current))
      }
    },
    [applyPayload, lang, renamingWorkspaceKey, showError, workspaceBusyKey, workspaceNameValue],
  )

  const handleWorkspaceRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, workspace: WorkspaceSummary) => {
      if (event.key === "Enter") {
        event.preventDefault()
        void submitWorkspaceRename(workspace)
      } else if (event.key === "Escape") {
        event.preventDefault()
        ++workspaceRenameRequestRef.current
        setRenamingWorkspaceKey(null)
        setWorkspaceNameValue(workspace.name)
      }
    },
    [submitWorkspaceRename],
  )

  const removeWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      if (workspaceBusyKey === workspace.key) return
      let shouldRemove: boolean
      try {
        shouldRemove = await confirm(
          t(lang, "removeProjectConfirm").replace("{name}", workspace.name),
          { title: t(lang, "removeProject"), kind: "warning" },
        )
      } catch (error) {
        showError(errorMessage(error, lang))
        return
      }
      if (!shouldRemove) return
      setWorkspaceBusyKey(workspace.key)
      try {
        applyPayload(await removeWorkspaceFromList(workspace.path))
        setRenamingWorkspaceKey((current) => (current === workspace.key ? null : current))
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setWorkspaceBusyKey((current) => (current === workspace.key ? null : current))
      }
    },
    [applyPayload, lang, showError, workspaceBusyKey],
  )

  const focusPersistentRailControl = useCallback(() => {
    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLElement)) return
    const rail = activeElement.closest<HTMLElement>(".project-rail")
    if (!rail || !activeElement.closest(".project-sessions, .open-project-button")) return
    rail.querySelector<HTMLButtonElement>(".rail-open-folder")?.focus()
  }, [])

  const refresh = useCallback(async () => {
    ++settingsRecoveryActionRef.current.request
    setSettingsRecoveryBusy(settingsRecoveryActionRef.current.active !== null)
    const request = ++refreshRequestRef.current
    const revision = payloadRevisionRef.current
    const current = () =>
      mountedRef.current &&
      request === refreshRequestRef.current &&
      revision === payloadRevisionRef.current
    setRefreshing(true)
    try {
      const next = await loadBootstrap()
      if (current()) {
        acceptStartupWorkspaceWarning(next.startupWorkspaceWarning ?? null)
        applyPayload(next)
      }
    } catch (error) {
      if (!current()) return
      const recovery = settingsUnavailableDetails(error)
      if (recovery) {
        setSettingsRecoveryActionError(null)
        setSettingsRecoveryRefreshError(null)
        settingsRecoveryRef.current = recovery
        setSettingsRecovery(recovery)
        setStartupError(recovery.message)
      } else {
        const message = errorMessage(error, langRef.current)
        setStartupError(message)
        if (settingsRecoveryRef.current) setSettingsRecoveryRefreshError(message)
        else showError(message)
      }
    } finally {
      if (mountedRef.current && request === refreshRequestRef.current) setRefreshing(false)
    }
  }, [acceptStartupWorkspaceWarning, applyPayload, showError])

  const runSettingsRecoveryAction = useCallback(
    async (action: "folder" | "retry" | "defaults") => {
      if (!settingsRecovery || settingsRecoveryActionRef.current.active !== null) return
      const request = ++settingsRecoveryActionRef.current.request
      ++refreshRequestRef.current
      setRefreshing(false)
      settingsRecoveryActionRef.current.active = request
      const current = () =>
        mountedRef.current && request === settingsRecoveryActionRef.current.request
      setSettingsRecoveryBusy(true)
      setSettingsRecoveryActionError(null)
      setSettingsRecoveryRefreshError(null)
      try {
        if (action === "folder") {
          await openSettingsFolder()
          return
        }
        if (action === "defaults") {
          const accepted = await confirm(t(lang, "startWithDefaultsConfirm"), {
            title: t(lang, "startWithDefaultsConfirmTitle"),
            kind: "warning",
          })
          if (!accepted || !current()) return
        }
        const next = await (action === "retry" ? loadBootstrap() : startWithDefaults())
        if (current()) {
          acceptStartupWorkspaceWarning(next.startupWorkspaceWarning ?? null)
          applyPayload(next)
        }
      } catch (error) {
        if (!current()) return
        const recovery = settingsUnavailableDetails(error)
        if (recovery) {
          settingsRecoveryRef.current = recovery
          setSettingsRecovery(recovery)
          setStartupError(recovery.message)
        } else {
          setSettingsRecoveryActionError(errorMessage(error, lang))
        }
      } finally {
        if (settingsRecoveryActionRef.current.active === request) {
          settingsRecoveryActionRef.current.active = null
          if (mountedRef.current) setSettingsRecoveryBusy(false)
        }
      }
    },
    [acceptStartupWorkspaceWarning, applyPayload, lang, settingsRecovery],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    let latestRequest = 0
    let pendingRequests = 0
    let needsReconcile = false
    void listen<SingleInstanceEvent>("single-instance", async (event) => {
      if (disposed) return
      if (event.payload.error) {
        ++latestRequest
        ++workspaceSelectionRequestRef.current
        showError(event.payload.error)
        return
      }
      const requested = event.payload.workspace
      if (requested) {
        const request = ++latestRequest
        const selectionRequest = ++workspaceSelectionRequestRef.current
        ++pendingRequests
        // A bootstrap started before this intent must not remove its workspace later.
        ++payloadRevisionRef.current
        try {
          const next = await addWorkspace(requested)
          if (disposed) return
          if (request !== latestRequest) {
            needsReconcile = true
            return
          }
          const selectRequested = selectionRequest === workspaceSelectionRequestRef.current
          acceptStartupWorkspaceWarning(null)
          applyPayload(next, selectRequested ? requested : undefined)
          if (selectRequested) {
            setSelectedSessionId(null)
            setSearch("")
          }
          return
        } catch (error) {
          if (!disposed && request === latestRequest) {
            showError(errorMessage(error, langRef.current))
            // The request invalidated in-flight bootstrap reads, even if no payload loaded yet.
            needsReconcile = true
          }
          return
        } finally {
          --pendingRequests
          if (!disposed && pendingRequests === 0 && needsReconcile) {
            needsReconcile = false
            // Backend commits can run in a different order from requests or responses.
            // Read the complete committed state; never merge or publish a stale snapshot.
            void refresh()
          }
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
  }, [acceptStartupWorkspaceWarning, applyPayload, refresh, showError])
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

      const sessionSelectionRequest = ++sessionSelectionRequestRef.current
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
      const workspaceSelectionRequest = workspaceSelectionRequestRef.current
      void loadBootstrap()
        .then((next) => {
          if (disposed) return
          const latest = discoveredSessionsRef.current.get(event.terminalId)
          if (latest && latest.id !== session.id) return
          applyPayload(mergeSessionIntoPayload(next, session, next.runtime.platform))
          if (
            sessionSelectionRequest === sessionSelectionRequestRef.current &&
            workspaceSelectionRequest === workspaceSelectionRequestRef.current
          ) {
            setSelectedSessionId(session.id)
          }
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

  const selectedWorkspacePath = payload ? (selectedWorkspace?.path ?? null) : undefined
  const currentWorkspacePathRef = useRef(selectedWorkspacePath)
  currentWorkspacePathRef.current = selectedWorkspacePath
  codexContextRef.current = { open: codexOpen, path: selectedWorkspacePath }
  useEffect(() => {
    // Feedback belongs to this import view and destination, not another project.
    codexViewRef.current += 1
    setCodexFailures({})
  }, [codexOpen, selectedWorkspacePath])
  useEffect(() => {
    const request = ++workspaceSaveRequestRef.current
    if (selectedWorkspacePath === undefined || startupWorkspaceWarning) return
    workspaceSaveRetryPendingRef.current = false
    setWorkspaceSaveBusy(true)
    setWorkspaceSaveFailure((failure) => (failure?.path === selectedWorkspacePath ? failure : null))
    // Serialize commits, not just responses; an older disk write must never win after a newer one.
    // Skip superseded queued selections and never apply bootstrap data from background persistence.
    workspaceSaveQueueRef.current = (workspaceSaveQueueRef.current ?? Promise.resolve())
      .then(async () => {
        if (!mountedRef.current || request !== workspaceSaveRequestRef.current) return
        await saveWorkspaceSelection(selectedWorkspacePath)
        if (
          mountedRef.current &&
          request === workspaceSaveRequestRef.current &&
          currentWorkspacePathRef.current === selectedWorkspacePath
        ) {
          setWorkspaceSaveFailure(null)
        }
      })
      .catch((error) => {
        if (
          mountedRef.current &&
          request === workspaceSaveRequestRef.current &&
          currentWorkspacePathRef.current === selectedWorkspacePath
        ) {
          setWorkspaceSaveFailure({
            path: selectedWorkspacePath,
            message: errorMessage(error, langRef.current),
          })
        }
      })
      .finally(() => {
        if (mountedRef.current && request === workspaceSaveRequestRef.current) {
          setWorkspaceSaveBusy(false)
          workspaceSaveRetryPendingRef.current = false
        }
      })
  }, [selectedWorkspacePath, startupWorkspaceWarning, workspaceSaveRetry])

  function retryWorkspaceSelection() {
    if (
      !mountedRef.current ||
      workspaceSaveBusy ||
      workspaceSaveRetryPendingRef.current ||
      !workspaceSaveFailure ||
      workspaceSaveFailure.path !== currentWorkspacePathRef.current
    )
      return
    workspaceSaveRetryPendingRef.current = true
    setWorkspaceSaveRetry((revision) => revision + 1)
  }

  useEffect(() => {
    let disposed = false
    setResourceHealth(null)
    setResourceHealthError(null)
    const poll = async (refreshAfterCurrent = false) => {
      if (disposed || document.visibilityState !== "visible") return
      if (resourceHealthSamplingRef.current) {
        // Explicit invalidations need one latest sample; periodic ticks must not
        // create a continuous backlog when sampling takes longer than the interval.
        if (refreshAfterCurrent) resourceHealthPendingRefreshRef.current = catchUp
        return
      }
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
        const pendingRefresh = resourceHealthPendingRefreshRef.current
        resourceHealthPendingRefreshRef.current = null
        pendingRefresh?.()
      }
    }
    const catchUp = () => void poll()
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void poll(true)
    }
    void poll(true)
    const interval = window.setInterval(() => void poll(), 30_000)
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
      if (resourceHealthPendingRefreshRef.current === catchUp) {
        resourceHealthPendingRefreshRef.current = null
      }
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
      ++sessionSelectionRequestRef.current
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
    setSettingsOpenedAt(null)
    setCodexOpen(false)
    closeTranscript()
    setResourceHealthOpen(false)
    setIncidentCenterOpen(true)
  }, [closeTranscript])
  const openResourceHealth = useCallback(() => {
    setSettingsOpenedAt(null)
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
      ++sessionSelectionRequestRef.current
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
    if (startupWorkspaceBusyRef.current) return
    const recovering = startupWorkspaceWarningRef.current !== null
    if (recovering) {
      startupWorkspaceBusyRef.current = true
      setStartupWorkspaceBusy(true)
      setStartupWorkspaceError(null)
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t(lang, "pickProjectDir"),
      })
      if (typeof selected !== "string") return
      const selectionRequest = ++workspaceSelectionRequestRef.current
      const next = await addWorkspace(selected)
      const selectRequested = selectionRequest === workspaceSelectionRequestRef.current
      acceptStartupWorkspaceWarning(null)
      applyPayload(next, selectRequested ? selected : undefined)
      if (selectRequested) {
        setSelectedSessionId(null)
        setSearch("")
      }
    } catch (error) {
      const message = errorMessage(error, lang)
      if (recovering) setStartupWorkspaceError(message)
      else showError(message)
    } finally {
      if (recovering) {
        startupWorkspaceBusyRef.current = false
        setStartupWorkspaceBusy(false)
      }
    }
  }, [acceptStartupWorkspaceWarning, applyPayload, lang, showError])

  const resolveStartup = useCallback(
    async (action: "retry" | "continue") => {
      const warning = startupWorkspaceWarningRef.current
      if (!warning || startupWorkspaceBusyRef.current) return
      startupWorkspaceBusyRef.current = true
      setStartupWorkspaceBusy(true)
      setStartupWorkspaceError(null)
      const selectionRequest = ++workspaceSelectionRequestRef.current
      ++payloadRevisionRef.current
      try {
        const next = await resolveStartupWorkspace(warning.requestedPath, action)
        if (!mountedRef.current) return
        // An acknowledgement owns only this failed launch intent, not newer navigation.
        if (startupWorkspaceWarningRef.current?.requestedPath === warning.requestedPath) {
          acceptStartupWorkspaceWarning(next.startupWorkspaceWarning ?? null)
        }
        if (selectionRequest !== workspaceSelectionRequestRef.current) {
          void refresh()
          return
        }
        const selectRequested =
          action === "retry" &&
          !next.startupWorkspaceWarning &&
          selectionRequest === workspaceSelectionRequestRef.current
        applyPayload(next, selectRequested ? warning.requestedPath : undefined)
      } catch (error) {
        if (mountedRef.current && selectionRequest === workspaceSelectionRequestRef.current)
          setStartupWorkspaceError(errorMessage(error, lang))
      } finally {
        startupWorkspaceBusyRef.current = false
        if (mountedRef.current) setStartupWorkspaceBusy(false)
      }
    },
    [acceptStartupWorkspaceWarning, applyPayload, lang, refresh],
  )

  const reveal = useCallback(
    (path: string) => {
      void revealItemInDir(path).catch((error) => showError(errorMessage(error, lang)))
    },
    [lang, showError],
  )

  const launchSession = useCallback(
    async (session?: SessionLaunchTarget, initialInput?: string) => {
      if (
        !payload ||
        startupWorkspaceWarningRef.current ||
        launchingRef.current ||
        isInstallingClientUpdate()
      )
        return
      const cwd = session?.cwd ?? selectedWorkspace?.path
      if (!cwd) {
        showError(t(lang, "requireProjectDir"))
        return
      }
      if (!payload.runtime.ompAvailable) {
        setSettingsOpenedAt(Date.now())
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
      launchingRef.current = true
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
        unpublishedTerminalIdsRef.current.add(tab.id)
        setTabs((current) => [...current, tab])
        setActiveTabId(tab.id)
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        launchingRef.current = false
        setLaunching(null)
      }
    },
    [
      focusTab,
      lang,
      isInstallingClientUpdate,
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
    if (
      !payload?.runtime.ompAvailable ||
      !selectedWorkspace?.path ||
      launchingRef.current ||
      isInstallingClientUpdate()
    )
      return
    const sourceTab =
      tabs.find((tab) => tab.id === updateSourceTerminalId && tab.status === "running") ??
      tabs.find((tab) => tab.status === "running" && tab.kind === "agent") ??
      null
    pendingUpdateRestartRef.current = null
    launchingRef.current = true
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
      unpublishedTerminalIdsRef.current.add(tab.id)
      setTabs((current) => [...current, tab])
      setActiveTabId(tab.id)
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      launchingRef.current = false
      setLaunching(null)
    }
  }, [
    isInstallingClientUpdate,
    lang,
    payload?.runtime.ompAvailable,
    selectedWorkspace?.path,
    showError,
    tabs,
    updateSourceTerminalId,
  ])

  const openCodexImport = useCallback(async () => {
    setCodexFailures({})
    setRailAutoOpen(true)
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
    const view = codexViewRef.current
    const targetPath = selectedWorkspace.path
    const currentView = () =>
      codexViewRef.current === view &&
      codexContextRef.current.open &&
      codexContextRef.current.path === targetPath
    setCodexFailures((current) => {
      const next = { ...current }
      for (const session of selected) delete next[session.filePath]
      return next
    })
    setImporting(true)
    try {
      const result = await importSessions(
        selected.map((session) => ({
          path: session.filePath,
          targetCwd: selectedWorkspace.path,
          mode: importMode,
        })),
      )
      applyPayload(result.bootstrap)
      const failures = result.items.filter((item) => item.status === "failed")
      const completed = result.items.filter((item) => item.status !== "failed")
      if (currentView() && completed.length > 0) {
        setCodexSelected((current) => {
          const next = { ...current }
          for (const item of completed) delete next[item.sourcePath]
          return next
        })
      }
      showNotice(summarizeImport(result.items, lang))
      if (failures.length > 0) {
        if (currentView()) {
          setCodexFailures((current) => ({
            ...current,
            ...Object.fromEntries(
              failures.map((item) => {
                const message = importFailureMessage(item, lang) || t(lang, "importItemFailed")
                return [
                  item.sourcePath,
                  message.slice(0, 2048) + (message.length > 2048 ? "…" : ""),
                ]
              }),
            ),
          }))
        }
        showError(failures.map((item) => importFailureMessage(item, lang)).join("\n"))
      } else if (currentView()) {
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
    setRailAutoOpen(true)
    setOmpFilePickerOpen(true)
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
    } finally {
      setOmpFilePickerOpen(false)
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
      applyPayload(result.bootstrap)
      const failure = result.items.find((item) => item.status === "failed")
      showNotice(summarizeImport(result.items, lang))
      if (failure) {
        showError(importFailureMessage(failure, lang))
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
            candidate.id === terminalId && candidate.switchRecovery?.token === recovery.token
              ? {
                  ...candidate,
                  // A generic failure may follow an uncertain PTY write. Never offer a second send.
                  switchRecovery: currentRecovery ?? {
                    ...candidate.switchRecovery,
                    state: "failedSend",
                  },
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
        isInstallingClientUpdate() ||
        restartingTerminalIdsRef.current.has(terminalId) ||
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
    [isInstallingClientUpdate, refresh, showError],
  )

  const handleReorderTabs = useCallback((draggedId: string, targetId: string) => {
    setTabs((current) => reorderTerminalTabs(current, draggedId, targetId))
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
        applyPayload(next)
        showNotice(t(lang, "sessionDeleted"))
      } catch (error) {
        showError(errorMessage(error, lang))
      } finally {
        setDeletingSessionId(null)
      }
    },
    [applyPayload, closeTab, lang, payload?.runtime.platform, showError, showNotice, tabs],
  )

  const updateSessionTitlePin = useCallback(
    async (session: SessionSummary, title: string | null) => {
      try {
        applyPayload(await setSessionTitlePin(session.filePath, title))
        return true
      } catch (error) {
        showError(errorMessage(error, lang))
        return false
      }
    },
    [applyPayload, lang, showError],
  )

  const startRenameSession = useCallback((session: SessionSummary) => {
    ++sessionRenameRequestRef.current
    setRenameValue(session.title)
    setRenamingSessionId(session.id)
  }, [])

  const changeRenameValue = useCallback((value: string) => {
    ++sessionRenameRequestRef.current
    setRenameValue(value)
  }, [])

  const toggleSessionTitlePin = useCallback(
    (session: SessionSummary) => {
      void updateSessionTitlePin(session, session.pinnedTitle ? null : session.title)
    },
    [updateSessionTitlePin],
  )

  const submitRenameSession = useCallback(
    async (session: SessionSummary) => {
      if (renamingSessionId !== session.id) return
      const request = sessionRenameRequestRef.current
      if (sessionRenamePendingRef.current === request) return
      const trimmed = renameValue.trim()
      if (!trimmed) {
        setRenamingSessionId(null)
        return
      }
      sessionRenamePendingRef.current = request
      try {
        if (await updateSessionTitlePin(session, trimmed)) {
          if (request === sessionRenameRequestRef.current) setRenamingSessionId(null)
        }
      } finally {
        if (sessionRenamePendingRef.current === request) sessionRenamePendingRef.current = null
      }
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
        ++sessionRenameRequestRef.current
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
      if (event.defaultPrevented || event.isComposing || startupWorkspaceWarningRef.current) return
      if (
        incidentCenterOpen ||
        resourceHealthOpen ||
        settingsOpen ||
        codexOpen ||
        ompFilePickerOpen ||
        copySession ||
        pendingOmpImportPath ||
        transcriptSession
      )
        return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey
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
    ompFilePickerOpen,
    pendingOmpImportPath,
    copySession,
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
        actionError={
          [settingsRecoveryActionError, settingsRecoveryRefreshError].filter(Boolean).join("\n") ||
          null
        }
        language={lang}
        recovery={settingsRecovery}
        onOpenFolder={() => void runSettingsRecoveryAction("folder")}
        onRetry={() => void runSettingsRecoveryAction("retry")}
        onStartWithDefaults={() => void runSettingsRecoveryAction("defaults")}
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
    <div
      inert={startupWorkspaceWarning !== null}
      className={`app-shell${payload.runtime.platform === "linux" ? " is-linux" : ""}`}
      style={{ fontFamily: payload.settings.appFontFamily }}
    >
      <Topbar
        appVersion={appVersion}
        checkingUpdate={checkingUpdate}
        checkingDesktopUpdate={checkingClientUpdate}
        installingDesktopUpdate={installingClientUpdate}
        onCheckDesktopUpdate={checkClientUpdateNow}
        incidentActiveTerminalCount={activeRuntimeTerminals}
        incidentCenterOpen={incidentCenterOpen}
        incidentTriggerRef={incidentCenterTriggerRef}
        language={lang}
        resourceHealth={resourceHealth}
        resourceHealthOpen={resourceHealthOpen}
        resourceTriggerRef={resourceHealthTriggerRef}
        onOpenIncidentCenter={openIncidentCenter}
        onOpenResourceHealth={openResourceHealth}
        onOpenSettings={() => setSettingsOpenedAt(Date.now())}
        onRefresh={() => void refresh()}
        onUpdate={() => void launchUpdate()}
        refreshing={refreshing}
        runtime={payload.runtime}
        selectedWorkspace={selectedWorkspace}
        updateInfo={updateInfo}
      />

      <div className="app-notices">
        {(ompConfigLoading || ompConfigError) && (
          <div
            className="transcript-truncated app-notice"
            role={ompConfigError ? "alert" : "status"}
          >
            <Icon name={ompConfigError ? "alert" : "refresh"} size={16} />
            <div className="app-notice-text">
              <strong>{t(lang, ompConfigError ? "ompConfigLoadError" : "ompConfigLoading")}</strong>
              {ompConfigError && <span>{ompConfigError}</span>}
            </div>
            {ompConfigError && (
              <button
                className="button secondary"
                onClick={() => setOmpConfigAttempt((value) => value + 1)}
                type="button"
              >
                <Icon name="refresh" size={14} /> {t(lang, "retry")}
              </button>
            )}
          </div>
        )}
        {workspaceSaveFailure && workspaceSaveFailure.path === selectedWorkspacePath && (
          <div
            className="transcript-truncated app-notice workspace-selection-warning"
            role="status"
          >
            <div className="app-notice-text">
              <strong>{t(lang, "workspaceSelectionNotSaved")}</strong>
              <span>{workspaceSaveFailure.path ?? t(lang, "noProject")}</span>
              <span>{workspaceSaveFailure.message}</span>
            </div>
            <button
              className="button secondary"
              type="button"
              disabled={workspaceSaveBusy}
              onClick={retryWorkspaceSelection}
            >
              <Icon name="refresh" size={14} /> {t(lang, "retry")}
            </button>
          </div>
        )}
        {payload.sessionWarnings.length > 0 && (
          <details className="transcript-truncated app-notice app-session-warnings">
            <summary>
              {t(lang, "sessionScanWarnings").replace(
                "{count}",
                String(payload.sessionWarnings.length),
              )}
            </summary>
            <div className="app-warning-actions">
              <span>{t(lang, "sessionScanWarningsHelp")}</span>
              <button
                className="button secondary"
                disabled={refreshing}
                onClick={() => void refresh()}
                type="button"
              >
                <Icon name="refresh" size={14} /> {t(lang, "retry")}
              </button>
            </div>
            <ul>
              {payload.sessionWarnings.map((warning, index) => (
                <li key={`${warning.path}-${index}`}>
                  <div className="app-notice-text">
                    <strong>{warning.path}</strong>
                    <span>{warning.message}</span>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => reveal(warning.path)}
                    type="button"
                  >
                    <Icon name="folderOpen" size={14} /> {t(lang, "showInExplorer")}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className={`workbench rail-${railMode === "autoHide" ? "auto-hide" : railMode}`}>
        <ProjectRail
          autoHidePaused={
            codexOpen ||
            ompFilePickerOpen ||
            copySession !== null ||
            pendingOmpImportPath !== null ||
            transcriptSession !== null
          }
          autoOpen={railAutoOpen}
          mode={railMode}
          modeSaving={railModeSaving}
          onAutoOpenChange={setRailAutoOpen}
          onModeChange={(mode) => void changeRailMode(mode)}
          onOpenFolder={() => void openFolder()}
          onSelectWorkspace={(key) => {
            ++workspaceSelectionRequestRef.current
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
          onWorkspaceNameChange={changeWorkspaceName}
          onWorkspaceRenameKeyDown={handleWorkspaceRenameKeyDown}
          sessionList={{
            canLaunch: payload.runtime.ompAvailable && !installingClientUpdate,
            allSessions: workspaceSessions,
            deletingSessionId,
            lang,
            launching,
            onClearSearch: () => setSearch(""),
            onDeleteSession: (session) => void deleteOmpSession(session),
            onImportOmp: () => void importOmpFile(),
            onCopySession: (session) => {
              if (
                launchingRef.current ||
                tabs.some(
                  (tab) =>
                    tab.status === "running" &&
                    tabMatchesSession(tab, session, payload.runtime.platform),
                )
              )
                return
              setCopySession({
                session,
                selectionRequest: workspaceSelectionRequestRef.current,
                sessionRequest: sessionSelectionRequestRef.current,
                payloadRevision: payloadRevisionRef.current,
              })
            },
            onLaunchSession: (session) => void launchSession(session),
            onLoadTranscript: (session) => void loadTranscript(session),
            onNewSession: () => void launchSession(),
            onOpenCodex: () => void openCodexImport(),
            onRenameKeyDown: handleRenameKeyDown,
            onRenameValueChange: changeRenameValue,
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
          launching={installingClientUpdate ? "desktop-update" : launching}
          installingDesktopUpdate={installingClientUpdate}
          ompConfig={ompConfig}
          onDiscardSwitchRecovery={(terminalId) => void discardRecoveredSwitchInput(terminalId)}
          onCloseTab={closeTab}
          onError={showError}
          onExit={handleExit}
          onFocusTab={focusTab}
          onLaunch={(session) => void launchSession(session)}
          onOpenFolder={() => void openFolder()}
          onReadTranscript={readTerminalTranscript}
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

      {settingsOpenedAt !== null && (
        <SettingsPanel
          initialOmpConfig={
            ompConfig &&
            ompConfigBaselineRef.current?.runtime.ompAvailable === payload.runtime.ompAvailable &&
            ompConfigBaselineRef.current.runtime.ompExecutable === payload.runtime.ompExecutable &&
            ompConfigBaselineRef.current.runtime.ompVersion === payload.runtime.ompVersion &&
            settingsOpenedAt - ompConfigBaselineRef.current.loadedAt < OMP_CONFIG_STALE_MS
              ? ompConfig
              : null
          }
          onClose={() => setSettingsOpenedAt(null)}
          onConfigLoaded={(snapshot) => acceptOmpConfig(snapshot, payload.runtime)}
          onError={showError}
          onNotice={showNotice}
          onSaved={handleSettingsSaved}
          runtime={payload.runtime}
          settings={payload.settings}
        />
      )}

      {transcriptSession && (
        <TranscriptModal
          initialPosition={transcriptInitialPosition}
          lang={lang}
          launching={launching}
          onClearSearch={() => setTranscriptSearch("")}
          onClose={closeTranscript}
          onError={showError}
          onModeChange={setTranscriptMode}
          onRefresh={() => void loadTranscript(transcriptSession)}
          onReread={() => void openAndRereadSession(transcriptSession)}
          onSearchChange={setTranscriptSearch}
          runtimeAvailable={payload.runtime.ompAvailable && !installingClientUpdate}
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
          failures={codexFailures}
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

      {copySession && (
        <SessionCopyModal
          key={copySession.session.filePath}
          session={copySession.session}
          language={lang}
          sourceBusy={
            launching === copySession.session.id ||
            tabs.some(
              (tab) =>
                tab.status === "running" &&
                tabMatchesSession(tab, copySession.session, payload.runtime.platform),
            )
          }
          onClose={() => {
            copyCloseFocusRef.current = {
              workspace: workspaceSelectionRequestRef.current,
              session: sessionSelectionRequestRef.current,
            }
            setCopySession(null)
          }}
          onImported={(result) => {
            if (payloadRevisionRef.current !== copySession.payloadRevision) {
              void refresh()
              return
            }
            const item = result.items[0]
            const imported = result.bootstrap.sessions.find(
              (session) => session.filePath === item?.destinationPath,
            )
            const selectCopy =
              imported &&
              workspaceSelectionRequestRef.current === copySession.selectionRequest &&
              sessionSelectionRequestRef.current === copySession.sessionRequest
            applyPayload(result.bootstrap, selectCopy ? imported.cwd : undefined)
            if (selectCopy) {
              setSelectedSessionId(imported.id)
              setSearch("")
            }
          }}
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

      <div className="notification-stack">
        {updateNoticeVisible && updateInfo?.hasUpdate && (
          <UpdateNotice
            disabled={launching !== null}
            title={t(lang, "updateToastTitle")}
            message={t(lang, "updateToastBody")
              .replace("{current}", updateInfo.currentVersion ?? t(lang, "notFound"))
              .replace("{latest}", updateInfo.latestVersion ?? t(lang, "updateAvailable"))}
            actionLabel={t(lang, "updateNow")}
            language={lang}
            onDismissSession={updateSourceTerminalId ? dismissUpdateForSession : undefined}
            onRemindLater={remindUpdateLater}
            onViewChanges={
              updateInfo.latestVersion
                ? () => openReleaseNotes(OMP_RELEASE_NOTES_URL, updateInfo.latestVersion ?? "")
                : undefined
            }
            onUpdate={() => void launchUpdate()}
          />
        )}

        {clientUpdate && (
          <UpdateNotice
            title={t(lang, "desktopUpdateAvailable")}
            message={t(lang, "desktopUpdateVersion").replace("{version}", clientUpdate.version)}
            actionLabel={t(
              lang,
              installingClientUpdate ? "desktopUpdateInstalling" : "desktopUpdateInstall",
            )}
            disabled={installingClientUpdate || checkingClientUpdate || launching !== null}
            language={lang}
            onRemindLater={remindClientUpdateLater}
            onUpdate={installAvailableClientUpdate}
            onViewChanges={() => openReleaseNotes(DESKTOP_RELEASE_NOTES_URL, clientUpdate.version)}
          />
        )}

        <ToastContainer language={lang} onDismiss={dismissToast} toasts={toastState.items} />
      </div>
      {startupWorkspaceWarning &&
        createPortal(
          <StartupWorkspaceRecovery
            warning={startupWorkspaceWarning}
            fallbackPath={selectedWorkspace?.path ?? null}
            language={lang}
            busy={startupWorkspaceBusy}
            error={startupWorkspaceError}
            onRetry={() => void resolveStartup("retry")}
            onContinue={() => void resolveStartup("continue")}
            onChoose={() => void openFolder()}
          />,
          document.body,
        )}
    </div>
  )
}

export default App

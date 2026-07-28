import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { listen } from "@tauri-apps/api/event"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import {
  addWorkspace,
  bootstrap as loadBootstrap,
  checkOmpUpdate,
  closeTerminal,
  deleteSession,
  errorMessage,
  importSession,
  listCodexSessions,
  loadOmpConfig,
  setSessionTitlePin,
  switchTerminal,
  startTerminal,
  writeTerminal,
} from "./api"
import { CodexImportModal } from "./CodexImportModal"
import { ClientUpdateNotice } from "./ClientUpdateNotice"
import { Icon } from "./Icon"
import { matchesSelector, splitSelector } from "./ModelPicker"
import { t, type Lang } from "./i18n"
import { ProjectRail } from "./ProjectRail"
import { SettingsPanel } from "./SettingsPanel"
import { TerminalWorkspace } from "./TerminalWorkspace"
import { Topbar } from "./Topbar"
import { TranscriptModal } from "./TranscriptModal"
import { UpdateNotice } from "./UpdateNotice"
import { ToastContainer, type ToastItem } from "./ToastContainer"
import type {
  BootstrapPayload,
  CodexSessionSummary,
  OmpUpdateInfo,
  PtyExitEvent,
  PtyRuntimeEvent,
  PtySessionEvent,
  PtyUpdateEvent,
  OmpConfigSnapshot,
  SessionSummary,
  TerminalTab,
} from "./types"
import { localeTag, normalizedPath, tabMatchesSession } from "./uiUtils"
import { useClientUpdater } from "./useClientUpdater"
import { useWindowActivity } from "./useWindowActivity"
import { useTranscript } from "./useTranscript"
import packageMetadata from "../package.json"
import "./App.css"

type PendingUpdateRestart = {
  updateTerminalId: string
  sourceTab: TerminalTab | null
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
>

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
  const [appVersion, setAppVersion] = useState(packageMetadata.version)
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const discoveredSessionsRef = useRef(new Map<string, SessionSummary>())
  const completionNotifiedRef = useRef(new Set<string>())
  const settingsWarningShownRef = useRef<string | null>(null)
  const pendingInitialInputRef = useRef(new Map<string, string>())
  const readyTerminalIdsRef = useRef(new Set<string>())
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [launching, setLaunching] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<OmpUpdateInfo | null>(null)
  const [updateSourceTerminalId, setUpdateSourceTerminalId] = useState<string | null>(null)
  const pendingUpdateRestartRef = useRef<PendingUpdateRestart | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateNoticeVisible, setUpdateNoticeVisible] = useState(false)
  const [codexOpen, setCodexOpen] = useState(false)
  const [codexSessions, setCodexSessions] = useState<CodexSessionSummary[]>([])
  const [codexSelected, setCodexSelected] = useState<Record<string, boolean>>({})
  const [codexLoading, setCodexLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  const [ompConfig, setOmpConfig] = useState<OmpConfigSnapshot | null>(null)

  useEffect(() => {
    if (!payload?.runtime.ompAvailable) return
    void loadOmpConfig().then(setOmpConfig).catch(console.error)
  }, [payload?.runtime.ompAvailable])
  const lang: Lang = payload?.settings.language === "en" ? "en" : "ru"
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
  const showError = useCallback((message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((current) => [...current, { id, kind: "error", message }])
  }, [])

  const showNotice = useCallback((message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((current) => [...current, { id, kind: "notice", message }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])
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
      setSelectedWorkspacePath((current) => {
        const preferred = preferredWorkspace ?? current
        if (preferred) {
          const preferredKey = normalizedPath(preferred, next.runtime.platform)
          const match = next.workspaces.find(
            (workspace) => normalizedPath(workspace.path, next.runtime.platform) === preferredKey,
          )
          if (match) return match.path
        }
        return next.workspaces[0]?.path ?? null
      })
      setSelectedSessionId((current) =>
        current && next.sessions.some((session) => session.id === current) ? current : null,
      )
    },
    [showNotice],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      applyPayload(await loadBootstrap())
    } catch (error) {
      const message = errorMessage(error, lang)
      setStartupError(message)
      showError(message)
    } finally {
      setRefreshing(false)
    }
  }, [applyPayload, lang, showError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let disposed = false
    const unlistenSession = listen<PtySessionEvent>("pty-session", ({ payload: event }) => {
      if (disposed) return
      const { session } = event
      discoveredSessionsRef.current.set(event.terminalId, session)
      setPayload((current) => {
        if (!current) return current
        const sessionPath = normalizedPath(session.filePath, current.runtime.platform)
        const sessions = [
          session,
          ...current.sessions.filter(
            (candidate) =>
              candidate.id !== session.id &&
              normalizedPath(candidate.filePath, current.runtime.platform) !== sessionPath,
          ),
        ].sort((left, right) => right.updatedAt - left.updatedAt)
        return { ...current, sessions }
      })
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
              }
            : tab,
        ),
      )
      void loadBootstrap()
        .then((next) => {
          if (!disposed) applyPayload(next)
        })
        .catch((error) => {
          if (!disposed) showError(errorMessage(error, lang))
        })
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, lang))
      return null
    })

    const unlistenRuntime = listen<PtyRuntimeEvent>("pty-runtime", ({ payload: event }) => {
      if (disposed) return
      if (event.model && event.modelRole === "fallback") {
        const model = event.model.split("/").at(-1) ?? event.model
        showNotice(t(lang, "fallbackSwitched").replace("{model}", model))
      }
      if (event.errorMessage) {
        showError(event.errorMessage)
      }
      setTabs((current) =>
        current.map((tab) =>
          tab.id === event.terminalId
            ? {
                ...tab,
                currentModel: event.model ?? tab.currentModel,
                currentModelRole:
                  event.model !== null ? (event.modelRole ?? "default") : tab.currentModelRole,
                currentThinking: event.thinkingLevel ?? tab.currentThinking,
                currentThinkingConfigured:
                  event.configuredThinkingLevel ?? tab.currentThinkingConfigured,
                activity: event.activity ?? tab.activity,
              }
            : tab,
        ),
      )
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, lang))
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
              currentVersion: payload?.runtime.ompVersion ?? null,
              latestVersion: null,
              message: "",
            },
      )
      setUpdateNoticeVisible(true)
    }).catch((error) => {
      if (!disposed) showError(errorMessage(error, lang))
      return null
    })

    return () => {
      disposed = true
      void unlistenSession.then((stop) => stop?.())
      void unlistenRuntime.then((stop) => stop?.())
      void unlistenUpdate.then((stop) => stop?.())
    }
  }, [applyPayload, lang, payload?.runtime.ompVersion, showError, showNotice])

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
      setUpdateNoticeVisible((current) => info.hasUpdate || current)
      if (!info.hasUpdate && !updateSourceTerminalId) {
        setUpdateNoticeVisible(false)
      }
    } catch {
      // A live PTY notice remains authoritative when the registry check is temporarily unavailable.
    } finally {
      setCheckingUpdate(false)
    }
  }, [updateSourceTerminalId])

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
    if (!payload || !selectedWorkspacePath) return null
    const selectedKey = normalizedPath(selectedWorkspacePath, payload.runtime.platform)
    return (
      payload.workspaces.find(
        (workspace) => normalizedPath(workspace.path, payload.runtime.platform) === selectedKey,
      ) ?? null
    )
  }, [payload, selectedWorkspacePath])

  const workspaceSessions = useMemo(() => {
    if (!payload || !selectedWorkspace) return []
    const workspaceKey = normalizedPath(selectedWorkspace.path, payload.runtime.platform)
    return payload.sessions.filter(
      (session) => normalizedPath(session.cwd, payload.runtime.platform) === workspaceKey,
    )
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
        const started = await startTerminal(cwd, session?.filePath ?? null)
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
          currentModel: initialModel
            ? splitSelector(initialModel.selector).base
            : initialSelector.base || undefined,
          currentModelRole: null,
          currentThinking: initialThinking,
          currentThinkingConfigured: initialConfiguredThinking,
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
      let nextPayload: BootstrapPayload | null = null
      for (const session of selected) {
        nextPayload = await importSession(session.filePath, selectedWorkspace.path)
      }
      if (nextPayload) applyPayload(nextPayload, selectedWorkspace.path)
      setCodexOpen(false)
      showNotice(`${t(lang, "imported")}: ${selected.length}`)
    } catch (error) {
      showError(errorMessage(error, lang))
    } finally {
      setImporting(false)
    }
  }, [
    applyPayload,
    codexSelected,
    codexSessions,
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
      const next = await importSession(selected, selectedWorkspace.path)
      applyPayload(next, selectedWorkspace.path)
      showNotice(t(lang, "imported"))
    } catch (error) {
      showError(errorMessage(error, lang))
    }
  }, [applyPayload, lang, selectedWorkspace?.path, showError, showNotice])

  const switchTerminalRuntime = useCallback(
    async (terminalId: string, model: string, thinking: string | null) => {
      const tab = tabs.find((candidate) => candidate.id === terminalId)
      if (!tab || tab.kind !== "agent" || tab.status !== "running" || tab.switching) return
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
          targetModel?.thinking ?? [],
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
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === terminalId ? { ...candidate, switching: false } : candidate,
          ),
        )
        showError(errorMessage(error, lang))
      }
    },
    [lang, ompConfig, refresh, showError, tabs],
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
      if (pendingUpdateRestartRef.current?.updateTerminalId === terminalId) {
        pendingUpdateRestartRef.current = null
      }
      pendingInitialInputRef.current.delete(terminalId)
      readyTerminalIdsRef.current.delete(terminalId)
      discoveredSessionsRef.current.delete(terminalId)
      completionNotifiedRef.current.delete(terminalId)
      void closeTerminal(terminalId).catch((error) => showError(errorMessage(error, lang)))
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
    [lang, showError],
  )

  const closeTab = useCallback(
    (terminalId: string) => {
      const target = tabs.find((tab) => tab.id === terminalId)
      if (!target || target.switching) return
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
        const next = await deleteSession(session.filePath)
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
            }
            showNotice(t(lang, "updateRestarted").replace("{title}", pendingUpdate.sourceTab.label))
            void launchSession(targetSession)
          }
        }
        void checkForUpdates()
        void refresh()
      }
    },
    [activeTabId, checkForUpdates, lang, launchSession, refresh, showNotice, tabs],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && transcriptSession) {
        event.preventDefault()
        closeTranscript()
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.shiftKey && event.code === "KeyO") {
        event.preventDefault()
        void openFolder()
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
  }, [activeTabId, closeTab, closeTranscript, launchSession, openFolder, transcriptSession])

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
    <div className="app-shell">
      <Topbar
        appVersion={appVersion}
        checkingUpdate={checkingUpdate}
        language={lang}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={() => void refresh()}
        onUpdate={() => void launchUpdate()}
        refreshing={refreshing}
        runtime={payload.runtime}
        selectedWorkspace={selectedWorkspace}
        updateInfo={updateInfo}
      />

      <div className="workbench">
        <ProjectRail
          onOpenFolder={() => void openFolder()}
          onSelectWorkspace={(path) => {
            setSelectedWorkspacePath(path)
            setSelectedSessionId(null)
            setSearch("")
          }}
          platform={payload.runtime.platform}
          selectedWorkspace={selectedWorkspace}
          sessionList={{
            canLaunch: payload.runtime.ompAvailable,
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
          language={lang}
          terminalFontFamily={payload.settings.terminalFontFamily}
          terminalFontSize={payload.settings.terminalFontSize}
          launching={launching}
          ompConfig={ompConfig}
          onCloseTab={closeTab}
          onError={showError}
          onExit={handleExit}
          onFocusTab={focusTab}
          onLaunch={(session) => void launchSession(session)}
          onOpenFolder={() => void openFolder()}
          onReorderTabs={handleReorderTabs}
          onReady={handleTerminalReady}
          onReveal={reveal}
          onSwitch={(tabId, model, thinking) => void switchTerminalRuntime(tabId, model, thinking)}
          onToggleTitlePin={toggleTabTitlePin}
          runtime={payload.runtime}
          selectedSession={selectedSession}
          selectedWorkspace={selectedWorkspace}
          tabs={tabs}
          workspaceSessions={workspaceSessions}
        />
      </div>

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
          onClose={() => setCodexOpen(false)}
          onImport={() => void importCodexSelected()}
          onSelectedChange={setCodexSelected}
          selected={codexSelected}
          sessions={codexSessions}
        />
      )}

      {updateNoticeVisible && updateInfo?.hasUpdate && (
        <UpdateNotice
          disabled={launching !== null}
          info={updateInfo}
          language={lang}
          onClose={() => setUpdateNoticeVisible(false)}
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

      <ToastContainer language={lang} onDismiss={dismissToast} toasts={toasts} />
    </div>
  )
}

export default App

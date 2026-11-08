import { useCallback, useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { confirm } from "@tauri-apps/plugin-dialog"
import { installClientUpdate } from "./clientUpdater"
import { desktopUpdateCheck, desktopUpdateStatus, errorMessage } from "./api"
import type { ClientUpdateInfo, DesktopUpdateStatus } from "./types"
import { t, type Lang } from "./i18n"
import {
  persistClientUpdateReminderSnooze,
  readClientUpdateReminderSnoozedUntil,
  UPDATE_REMINDER_SNOOZE_MS,
} from "./updateReminder"

export interface ClientUpdaterState {
  update: ClientUpdateInfo | null
  installing: boolean
  installed: boolean
  isInstalling: () => boolean
  checking: boolean
  checkNow: () => void
  remindLater: () => void
  install: () => void
}

function offered(status: DesktopUpdateStatus | null): ClientUpdateInfo | null {
  if (status?.installState === "installed") return status.installed
  return status?.policyState === "ready" && status.installState === "idle" && !status.checking
    ? status.update
    : null
}

export function useClientUpdater(
  language: Lang,
  showError: (message: string) => void,
  showNotice: (message: string) => void,
  safety: () => { runningTerminalCount: number; launching: boolean },
): ClientUpdaterState {
  const callbacks = useRef({ language, showError, showNotice, safety })
  callbacks.current = { language, showError, showNotice, safety }
  const statusRef = useRef<DesktopUpdateStatus | null>(null)
  const revisionRef = useRef<bigint | null>(null)
  const epochRef = useRef(0)
  const mountedRef = useRef(false)
  const installingRef = useRef(false)
  const checkRef = useRef(0)
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState(readClientUpdateReminderSnoozedUntil)
  const isInstalling = useCallback(
    () =>
      installingRef.current ||
      statusRef.current?.installState === "downloading" ||
      statusRef.current?.installState === "installing",
    [],
  )
  const accept = useCallback((next: DesktopUpdateStatus) => {
    if (!mountedRef.current) return false
    const revision = BigInt(next.revision)
    if (revisionRef.current !== null && revision < revisionRef.current) return false
    const previous = statusRef.current
    if (
      next.policyState !== "ready" ||
      (previous !== null &&
        (previous.policyState !== next.policyState ||
          previous.includePrereleases !== next.includePrereleases))
    ) {
      checkRef.current += 1
      setChecking(false)
    }
    revisionRef.current = revision
    statusRef.current = next
    setStatus(next)
    return true
  }, [])

  const checkForUpdate = useCallback(
    async (manual = false) => {
      if (!mountedRef.current || isInstalling()) return
      const request = ++checkRef.current
      const epoch = epochRef.current
      const current = () => mountedRef.current && request === checkRef.current
      // A fresh check cannot leave the previous candidate clickable, including on failure.
      statusRef.current = statusRef.current ? { ...statusRef.current, update: null } : null
      setStatus(statusRef.current)
      setChecking(true)
      try {
        const next = await desktopUpdateCheck()
        if (!current()) return
        if (epoch === epochRef.current) accept(next)
        else {
          const observedEpoch = epochRef.current
          const actual = await desktopUpdateStatus()
          if (current() && observedEpoch === epochRef.current) accept(actual)
        }
        if (manual && current()) {
          persistClientUpdateReminderSnooze(0)
          setSnoozedUntil(0)
          const { language, showNotice } = callbacks.current
          if (statusRef.current?.policyState === "ready" && !offered(statusRef.current)) {
            showNotice(t(language, "desktopUpdateCurrent"))
          }
        }
      } catch (error) {
        if (current() && manual) {
          const { language, showError } = callbacks.current
          showError(errorMessage(error, language))
        }
      } finally {
        if (current()) setChecking(false)
      }
    },
    [accept, isInstalling],
  )

  useEffect(() => {
    const epochCounter = epochRef
    const checkCounter = checkRef
    mountedRef.current = true
    let disposed = false
    const subscription = listen<DesktopUpdateStatus>("desktop-update-state", ({ payload }) => {
      if (
        disposed ||
        (revisionRef.current !== null && BigInt(payload.revision) <= revisionRef.current)
      )
        return
      if (accept(payload)) ++epochRef.current
    })
    void (async () => {
      try {
        await subscription
        if (disposed) return
        const epoch = epochRef.current
        const initial = await desktopUpdateStatus()
        if (disposed) return
        if (epoch === epochRef.current) accept(initial)
        await checkForUpdate()
      } catch {
        // No native authority means no offer. Background/offline discovery stays quiet.
      }
    })()
    const interval = window.setInterval(() => void checkForUpdate(), 15 * 60 * 1_000)
    const visibility = () => {
      if (document.visibilityState === "visible") void checkForUpdate()
    }
    document.addEventListener("visibilitychange", visibility)
    return () => {
      disposed = true
      mountedRef.current = false
      epochCounter.current += 1
      checkCounter.current += 1
      void subscription.then((unlisten) => unlisten()).catch(() => undefined)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [accept, checkForUpdate])

  useEffect(() => {
    if (snoozedUntil === 0) return
    const timer = window.setTimeout(
      () => {
        persistClientUpdateReminderSnooze(0)
        setSnoozedUntil(0)
      },
      Math.max(0, snoozedUntil - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [snoozedUntil])

  const remindLater = useCallback(() => {
    const until = Date.now() + UPDATE_REMINDER_SNOOZE_MS
    persistClientUpdateReminderSnooze(until)
    setSnoozedUntil(until)
  }, [])

  const install = useCallback(async () => {
    if (!mountedRef.current || isInstalling() || checking) return
    const candidate = offered(statusRef.current)
    if (!candidate) return
    const { language, showNotice, showError, safety } = callbacks.current
    if (safety().launching) {
      showNotice(t(language, "desktopUpdateWaitForLaunch"))
      return
    }
    installingRef.current = true
    setInstalling(true)
    try {
      const epoch = epochRef.current
      const revision = statusRef.current?.revision
      let confirmedRunning = 0
      if (candidate.prerelease && statusRef.current?.installState !== "installed") {
        if (
          !(await confirm(
            t(language, "desktopUpdatePrereleaseConfirm").replace("{version}", candidate.version),
            { title: t(language, "desktopUpdateInstall"), kind: "warning" },
          ))
        )
          return
      }
      // Confirmation is asynchronous: terminals, policy and the candidate can change meanwhile.
      while (mountedRef.current) {
        const currentSafety = callbacks.current.safety()
        if (currentSafety.launching) {
          showNotice(t(language, "desktopUpdateWaitForLaunch"))
          return
        }
        if (currentSafety.runningTerminalCount <= confirmedRunning) break
        confirmedRunning = currentSafety.runningTerminalCount
        if (
          !(await confirm(
            t(language, "desktopUpdateRunningConfirm").replace("{count}", String(confirmedRunning)),
            { title: t(language, "desktopUpdateInstall"), kind: "warning" },
          ))
        )
          return
      }
      if (
        !mountedRef.current ||
        epoch !== epochRef.current ||
        statusRef.current?.revision !== revision ||
        offered(statusRef.current)?.candidateId !== candidate.candidateId
      )
        return
      const actual = await desktopUpdateStatus()
      if (!mountedRef.current || epoch !== epochRef.current) return
      if (!accept(actual)) return
      if (offered(actual)?.candidateId !== candidate.candidateId) return
      const latestSafety = callbacks.current.safety()
      if (latestSafety.launching || latestSafety.runningTerminalCount > confirmedRunning) {
        showNotice(t(language, "desktopUpdateWaitForLaunch"))
        return
      }
      await installClientUpdate(candidate.candidateId)
    } catch (error) {
      if (mountedRef.current) showError(errorMessage(error, language))
    } finally {
      if (mountedRef.current) {
        const epoch = epochRef.current
        try {
          const actual = await desktopUpdateStatus()
          if (mountedRef.current && epoch === epochRef.current) accept(actual)
        } catch {
          if (mountedRef.current && epoch === epochRef.current) {
            statusRef.current = null
            setStatus(null)
          }
        }
        if (mountedRef.current) setInstalling(false)
      }
      installingRef.current = false
    }
  }, [accept, checking, isInstalling])

  return {
    update: snoozedUntil === 0 && !checking ? offered(status) : null,
    checking: checking || status?.checking === true,
    installing:
      installing || status?.installState === "downloading" || status?.installState === "installing",
    installed: status?.installState === "installed" && status.installed !== null,
    isInstalling,
    checkNow: () => void checkForUpdate(true),
    remindLater,
    install: () => void install(),
  }
}

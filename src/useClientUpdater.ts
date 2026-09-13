import { useCallback, useEffect, useRef, useState } from "react"
import { confirm } from "@tauri-apps/plugin-dialog"
import { checkClientUpdate, installClientUpdate, type ClientUpdateInfo } from "./clientUpdater"
import { t, type Lang } from "./i18n"
import { errorMessage } from "./api"
import {
  persistClientUpdateReminderSnooze,
  readClientUpdateReminderSnoozedUntil,
  UPDATE_REMINDER_SNOOZE_MS,
} from "./updateReminder"

interface ClientUpdaterState {
  update: ClientUpdateInfo | null
  installing: boolean
  checking: boolean
  checkNow: () => void
  remindLater: () => void
  install: () => void
}

export function useClientUpdater(
  language: Lang,
  showError: (message: string) => void,
  showNotice: (message: string) => void,
  safety: { runningTerminalCount: number; launching: boolean },
): ClientUpdaterState {
  const checkingRef = useRef(false)
  const manualCheckRef = useRef(false)
  const installingRef = useRef(false)
  const [checking, setChecking] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<ClientUpdateInfo | null>(null)
  const [snoozedUntil, setSnoozedUntil] = useState(readClientUpdateReminderSnoozedUntil)
  const [installing, setInstalling] = useState(false)

  const checkForUpdate = useCallback(
    async (manual = false) => {
      if (installingRef.current) return
      if (manual) manualCheckRef.current = true
      if (checkingRef.current) return
      checkingRef.current = true
      setChecking(true)
      try {
        const update = await checkClientUpdate()
        setAvailableUpdate(update)
        if (manualCheckRef.current) {
          persistClientUpdateReminderSnooze(0)
          setSnoozedUntil(0)
          if (!update) showNotice(t(language, "desktopUpdateCurrent"))
        }
      } catch (error) {
        // Background checks stay quiet offline; a requested check must report failure.
        if (manualCheckRef.current) showError(errorMessage(error, language))
      } finally {
        checkingRef.current = false
        manualCheckRef.current = false
        setChecking(false)
      }
    },
    [language, showError, showNotice],
  )

  useEffect(() => {
    void checkForUpdate()
    const interval = window.setInterval(() => void checkForUpdate(), 15 * 60 * 1_000)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void checkForUpdate()
    }
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [checkForUpdate])

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
    if (installingRef.current || checkingRef.current) return
    if (safety.launching) {
      showNotice(t(language, "desktopUpdateWaitForLaunch"))
      return
    }
    installingRef.current = true
    setInstalling(true)
    try {
      if (safety.runningTerminalCount > 0) {
        const accepted = await confirm(
          t(language, "desktopUpdateRunningConfirm").replace(
            "{count}",
            String(safety.runningTerminalCount),
          ),
          { title: t(language, "desktopUpdateInstall"), kind: "warning" },
        )
        if (!accepted) return
      }
      await installClientUpdate()
    } catch (error) {
      showError(errorMessage(error, language))
    } finally {
      installingRef.current = false
      setInstalling(false)
    }
  }, [language, safety.launching, safety.runningTerminalCount, showError, showNotice])

  return {
    update: snoozedUntil === 0 ? availableUpdate : null,
    checking,
    checkNow: () => void checkForUpdate(true),
    installing,
    remindLater,
    install: () => void install(),
  }
}

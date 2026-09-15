import { useCallback, useEffect, useRef, useState } from "react"
import { checkClientUpdate, installClientUpdate, type ClientUpdateInfo } from "./clientUpdater"
import type { Lang } from "./i18n"
import { errorMessage } from "./api"
import {
  persistClientUpdateReminderSnooze,
  readClientUpdateReminderSnoozedUntil,
  UPDATE_REMINDER_SNOOZE_MS,
} from "./updateReminder"

interface ClientUpdaterState {
  update: ClientUpdateInfo | null
  installing: boolean
  remindLater: () => void
  install: () => void
}

export function useClientUpdater(
  language: Lang,
  showError: (message: string) => void,
): ClientUpdaterState {
  const checkingRef = useRef(false)
  const [availableUpdate, setAvailableUpdate] = useState<ClientUpdateInfo | null>(null)
  const [snoozedUntil, setSnoozedUntil] = useState(readClientUpdateReminderSnoozedUntil)
  const [installing, setInstalling] = useState(false)

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      setAvailableUpdate(await checkClientUpdate())
    } catch {
      // The updater is optional while running a browser preview or offline.
    } finally {
      checkingRef.current = false
    }
  }, [])

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
    setInstalling(true)
    try {
      await installClientUpdate()
    } catch (error) {
      showError(errorMessage(error, language))
    } finally {
      setInstalling(false)
    }
  }, [language, showError])

  return {
    update: snoozedUntil === 0 ? availableUpdate : null,
    installing,
    remindLater,
    install: () => void install(),
  }
}

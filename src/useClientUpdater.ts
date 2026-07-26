import { useCallback, useEffect, useRef, useState } from "react"
import { checkClientUpdate, installClientUpdate, type ClientUpdateInfo } from "./clientUpdater"
import type { Lang } from "./i18n"
import { errorMessage } from "./api"

interface ClientUpdaterState {
  update: ClientUpdateInfo | null
  installing: boolean
  dismiss: () => void
  install: () => void
}

export function useClientUpdater(
  language: Lang,
  showError: (message: string) => void,
): ClientUpdaterState {
  const checkingRef = useRef(false)
  const [update, setUpdate] = useState<ClientUpdateInfo | null>(null)
  const [installing, setInstalling] = useState(false)

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      setUpdate(await checkClientUpdate())
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
    update,
    installing,
    dismiss: () => setUpdate(null),
    install: () => void install(),
  }
}

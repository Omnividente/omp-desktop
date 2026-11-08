import { relaunch } from "@tauri-apps/plugin-process"
import { desktopUpdateInstall, desktopUpdateStatus } from "./api"

let installing: Promise<void> | null = null

export async function installClientUpdate(candidateId: string): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    // IPC failure may follow installation. Always reconcile before another explicit attempt.
    const current = await desktopUpdateStatus()
    if (current.installState === "installed" && current.installed) {
      await relaunch()
      return
    }
    if (
      current.policyState !== "ready" ||
      current.installState !== "idle" ||
      current.checking ||
      current.update?.candidateId !== candidateId
    ) {
      throw new Error("Desktop update is no longer available. Check for updates again.")
    }
    let result
    try {
      result = await desktopUpdateInstall(candidateId)
    } catch (error) {
      // Read only: never resubmit installation after an unknown response.
      await desktopUpdateStatus().catch(() => undefined)
      throw error
    }
    if (result.installState !== "installed" || !result.installed) {
      throw new Error("Desktop installation is not confirmed. Check its status before retrying.")
    }
    // Rust retains the installed identity even if process relaunch fails or policy changes.
    await relaunch()
  })()
  try {
    await installing
  } finally {
    installing = null
  }
}

import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"

export interface ClientUpdateInfo {
  version: string
  date: string | null
  body: string | null
}

let pendingUpdate: Update | null = null
let checking: Promise<ClientUpdateInfo | null> | null = null
let installing: Promise<void> | null = null

function updateInfo(update: Update | null): ClientUpdateInfo | null {
  return update
    ? { version: update.version, date: update.date ?? null, body: update.body ?? null }
    : null
}

export async function checkClientUpdate(): Promise<ClientUpdateInfo | null> {
  if (installing) return updateInfo(pendingUpdate)
  if (checking) return checking
  checking = (async () => {
    const update = await check()
    const previous = pendingUpdate
    pendingUpdate = update
    if (previous && previous !== update) {
      try {
        await previous.close()
      } catch {
        // Releasing an unused SDK resource must not discard the fresh result.
      }
    }
    return updateInfo(update)
  })()
  try {
    return await checking
  } finally {
    checking = null
  }
}

export async function installClientUpdate(): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    if (checking) await checking
    const update = pendingUpdate
    if (!update) {
      throw new Error("Обновление Desktop больше недоступно. Проверьте его повторно.")
    }
    await update.downloadAndInstall()
    // Retain the candidate on a failed install, so the normal retry remains usable.
    pendingUpdate = null
    try {
      await update.close()
    } catch {
      // Some platforms consume the resource during installation.
    }
    await relaunch()
  })()
  try {
    await installing
  } finally {
    installing = null
  }
}

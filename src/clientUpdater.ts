import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"

export interface ClientUpdateInfo {
  version: string
  date: string | null
  body: string | null
}

let pendingUpdate: Update | null = null

export async function checkClientUpdate(): Promise<ClientUpdateInfo | null> {
  const update = await check()
  pendingUpdate = update
  if (!update) return null
  return {
    version: update.version,
    date: update.date ?? null,
    body: update.body ?? null,
  }
}

export async function installClientUpdate(): Promise<void> {
  if (!pendingUpdate) {
    throw new Error("Обновление Desktop больше недоступно. Проверьте его повторно.")
  }
  await pendingUpdate.downloadAndInstall()
  await relaunch()
}

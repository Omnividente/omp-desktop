export const UPDATE_REMINDER_SNOOZE_MS = 5 * 60 * 60 * 1_000

const UPDATE_REMINDER_SNOOZE_STORAGE_KEY = "omp-desktop:omp-update-snoozed-until"
const CLIENT_UPDATE_REMINDER_SNOOZE_STORAGE_KEY = "omp-desktop:client-update-snoozed-until"

type ReminderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function browserStorage(): ReminderStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function readReminderSnoozedUntil(
  key: string,
  storage: ReminderStorage | null,
  now: number,
): number {
  if (!storage) return 0
  try {
    const value = Number(storage.getItem(key))
    if (Number.isSafeInteger(value) && value > now) return value
    storage.removeItem(key)
  } catch {
    // Storage is optional; callers retain the timestamp in memory for this process.
  }
  return 0
}

function persistReminderSnooze(
  key: string,
  until: number,
  storage: ReminderStorage | null,
  now: number,
): void {
  if (!storage) return
  try {
    if (until > now) {
      storage.setItem(key, String(until))
    } else {
      storage.removeItem(key)
    }
  } catch {
    // Storage is optional; callers retain the timestamp in memory for this process.
  }
}

export function readUpdateReminderSnoozedUntil(
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): number {
  return readReminderSnoozedUntil(UPDATE_REMINDER_SNOOZE_STORAGE_KEY, storage, now)
}

export function persistUpdateReminderSnooze(
  until: number,
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): void {
  persistReminderSnooze(UPDATE_REMINDER_SNOOZE_STORAGE_KEY, until, storage, now)
}

export function readClientUpdateReminderSnoozedUntil(
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): number {
  return readReminderSnoozedUntil(CLIENT_UPDATE_REMINDER_SNOOZE_STORAGE_KEY, storage, now)
}

export function persistClientUpdateReminderSnooze(
  until: number,
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): void {
  persistReminderSnooze(CLIENT_UPDATE_REMINDER_SNOOZE_STORAGE_KEY, until, storage, now)
}

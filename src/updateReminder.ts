export const UPDATE_REMINDER_SNOOZE_MS = 5 * 60 * 60 * 1_000

const UPDATE_REMINDER_SNOOZE_STORAGE_KEY = "omp-desktop:omp-update-snoozed-until"

type ReminderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function browserStorage(): ReminderStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function readUpdateReminderSnoozedUntil(
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): number {
  if (!storage) return 0
  try {
    const value = Number(storage.getItem(UPDATE_REMINDER_SNOOZE_STORAGE_KEY))
    if (Number.isSafeInteger(value) && value > now) return value
    storage.removeItem(UPDATE_REMINDER_SNOOZE_STORAGE_KEY)
  } catch {
    // Storage is optional; callers retain the timestamp in memory for this process.
  }
  return 0
}

export function persistUpdateReminderSnooze(
  until: number,
  storage: ReminderStorage | null = browserStorage(),
  now = Date.now(),
): void {
  if (!storage) return
  try {
    if (until > now) {
      storage.setItem(UPDATE_REMINDER_SNOOZE_STORAGE_KEY, String(until))
    } else {
      storage.removeItem(UPDATE_REMINDER_SNOOZE_STORAGE_KEY)
    }
  } catch {
    // Storage is optional; callers retain the timestamp in memory for this process.
  }
}

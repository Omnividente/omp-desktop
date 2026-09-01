import { describe, expect, it } from "vitest"
import {
  persistClientUpdateReminderSnooze,
  persistUpdateReminderSnooze,
  readClientUpdateReminderSnoozedUntil,
  readUpdateReminderSnoozedUntil,
} from "./updateReminder"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe("OMP update reminder snooze", () => {
  it("survives a reload until the stored deadline", () => {
    const storage = memoryStorage()
    persistUpdateReminderSnooze(19_000, storage, 1_000)

    expect(readUpdateReminderSnoozedUntil(storage, 5_000)).toBe(19_000)
  })

  it("removes an expired or invalid deadline", () => {
    const storage = memoryStorage()
    persistUpdateReminderSnooze(19_000, storage, 1_000)
    expect(readUpdateReminderSnoozedUntil(storage, 20_000)).toBe(0)
    expect(readUpdateReminderSnoozedUntil(storage, 5_000)).toBe(0)
  })

  it("degrades safely when storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    }

    expect(readUpdateReminderSnoozedUntil(unavailable, 1_000)).toBe(0)
    expect(() => persistUpdateReminderSnooze(19_000, unavailable, 1_000)).not.toThrow()
  })
})

describe("OMP Desktop update reminder snooze", () => {
  it("survives a reload without changing the OMP reminder", () => {
    const storage = memoryStorage()
    persistUpdateReminderSnooze(19_000, storage, 1_000)
    persistClientUpdateReminderSnooze(29_000, storage, 1_000)

    expect(readUpdateReminderSnoozedUntil(storage, 5_000)).toBe(19_000)
    expect(readClientUpdateReminderSnoozedUntil(storage, 5_000)).toBe(29_000)
  })

  it("removes an expired deadline", () => {
    const storage = memoryStorage()
    persistClientUpdateReminderSnooze(19_000, storage, 1_000)

    expect(readClientUpdateReminderSnoozedUntil(storage, 20_000)).toBe(0)
    expect(readClientUpdateReminderSnoozedUntil(storage, 5_000)).toBe(0)
  })
})

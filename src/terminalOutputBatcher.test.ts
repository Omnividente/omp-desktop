import { describe, expect, it } from "vitest"
import { createTerminalOutputBatcher, type TerminalOutputScheduler } from "./terminalOutputBatcher"

function schedulerHarness() {
  let nextHandle = 1
  let now = 0
  const callbacks = new Map<number, { at: number; callback: () => void }>()
  const scheduler: TerminalOutputScheduler = {
    schedule(callback, delayMs) {
      const handle = nextHandle++
      callbacks.set(handle, { at: now + delayMs, callback })
      return handle
    },
    cancel(handle) {
      callbacks.delete(handle)
    },
  }
  const runNext = () => {
    const next = callbacks.entries().next().value
    if (!next) return
    const [handle, entry] = next
    callbacks.delete(handle)
    now = entry.at
    entry.callback()
  }
  const advance = (milliseconds: number) => {
    const target = now + milliseconds
    while (callbacks.size > 0) {
      const next = callbacks.values().next().value
      if (!next || next.at > target) break
      runNext()
    }
    now = target
  }
  return { scheduler, runNext, advance, now: () => now }
}

describe("terminal output batching", () => {
  it("writes the leading chunk immediately and coalesces trailing chunks", () => {
    const writes: Uint8Array[] = []
    const { scheduler, runNext } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 64)

    batcher.enqueue(Uint8Array.from([1, 2]))
    batcher.enqueue(Uint8Array.from([3]))
    batcher.enqueue(Uint8Array.from([4]))

    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1, 2])
    runNext()
    expect(writes).toHaveLength(2)
    expect(Array.from(writes[1])).toEqual([3, 4])
  })

  it("flushes trailing chunks immediately at the byte limit", () => {
    const writes: Uint8Array[] = []
    const { scheduler } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 4)

    batcher.enqueue(Uint8Array.from([1]))
    batcher.enqueue(Uint8Array.from([2, 3]))
    batcher.enqueue(Uint8Array.from([4, 5]))

    expect(writes).toHaveLength(2)
    expect(Array.from(writes[0])).toEqual([1])
    expect(Array.from(writes[1])).toEqual([2, 3, 4, 5])
  })

  it("drops only pending output after disposal", () => {
    const writes: Uint8Array[] = []
    const { scheduler, runNext } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler)

    batcher.enqueue(Uint8Array.from([1]))
    batcher.enqueue(Uint8Array.from([2]))
    batcher.dispose()
    runNext()
    batcher.enqueue(Uint8Array.from([3]))
    batcher.flush()

    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1])
  })

  it("keeps sustained writes spaced after a trailing flush without losing bytes", () => {
    const writes: { at: number; bytes: number[] }[] = []
    const clock = schedulerHarness()
    const batcher = createTerminalOutputBatcher(
      (output) => writes.push({ at: clock.now(), bytes: Array.from(output) }),
      clock.scheduler,
      50,
    )

    try {
      batcher.enqueue(Uint8Array.from([0]))
      for (let value = 1; value <= 8; value += 1) {
        clock.advance(23)
        batcher.enqueue(Uint8Array.from([value]))
      }
      clock.advance(50)

      expect(writes.map((entry) => entry.at)).toEqual([0, 50, 100, 150, 200])
      expect(writes.flatMap((entry) => entry.bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    } finally {
      batcher.dispose()
    }
  })
})

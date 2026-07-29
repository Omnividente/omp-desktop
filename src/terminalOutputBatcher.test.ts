import { describe, expect, it } from "vitest"
import { createTerminalOutputBatcher, type TerminalOutputScheduler } from "./terminalOutputBatcher"

function schedulerHarness() {
  let nextHandle = 1
  const callbacks = new Map<number, () => void>()
  const cancelled: number[] = []
  const scheduler: TerminalOutputScheduler = {
    schedule(callback) {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancel(handle) {
      callbacks.delete(handle)
      cancelled.push(handle)
    },
  }
  return { scheduler, callbacks, cancelled }
}

describe("terminal output batching", () => {
  it("coalesces chunks in byte order on one timer", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 64)

    batcher.enqueue(Uint8Array.from([1, 2]))
    batcher.enqueue(Uint8Array.from([3, 4]))

    expect(writes).toHaveLength(0)
    expect(callbacks).toHaveLength(1)
    callbacks.values().next().value?.()
    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1, 2, 3, 4])
  })

  it("flushes immediately at the byte limit", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks, cancelled } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 4)

    batcher.enqueue(Uint8Array.from([1, 2]))
    batcher.enqueue(Uint8Array.from([3, 4]))

    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1, 2, 3, 4])
    expect(callbacks).toHaveLength(0)
    expect(cancelled).toEqual([1])
  })

  it("drops pending output after disposal", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler)

    batcher.enqueue(Uint8Array.from([1]))
    batcher.dispose()
    for (const callback of callbacks.values()) callback()
    batcher.enqueue(Uint8Array.from([2]))
    batcher.flush()

    expect(writes).toHaveLength(0)
  })
})

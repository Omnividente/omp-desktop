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
  const runNext = () => {
    const next = callbacks.entries().next().value
    if (!next) return
    const [handle, callback] = next
    callbacks.delete(handle)
    callback()
  }
  return { scheduler, callbacks, cancelled, runNext }
}

describe("terminal output batching", () => {
  it("writes the leading chunk immediately and coalesces trailing chunks", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks, runNext } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 64)

    batcher.enqueue(Uint8Array.from([1, 2]))
    batcher.enqueue(Uint8Array.from([3]))
    batcher.enqueue(Uint8Array.from([4]))

    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1, 2])
    expect(callbacks.size).toBe(1)
    runNext()
    expect(writes).toHaveLength(2)
    expect(Array.from(writes[1])).toEqual([3, 4])
    expect(callbacks.size).toBe(0)
  })

  it("flushes trailing chunks immediately at the byte limit", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks, cancelled } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler, 16, 4)

    batcher.enqueue(Uint8Array.from([1]))
    batcher.enqueue(Uint8Array.from([2, 3]))
    batcher.enqueue(Uint8Array.from([4, 5]))

    expect(writes).toHaveLength(2)
    expect(Array.from(writes[0])).toEqual([1])
    expect(Array.from(writes[1])).toEqual([2, 3, 4, 5])
    expect(callbacks.size).toBe(1)
    expect(cancelled).toEqual([1])
  })

  it("drops only pending output after disposal", () => {
    const writes: Uint8Array[] = []
    const { scheduler, callbacks, cancelled, runNext } = schedulerHarness()
    const batcher = createTerminalOutputBatcher((output) => writes.push(output), scheduler)

    batcher.enqueue(Uint8Array.from([1]))
    batcher.enqueue(Uint8Array.from([2]))
    batcher.dispose()
    runNext()
    batcher.enqueue(Uint8Array.from([3]))
    batcher.flush()

    expect(writes).toHaveLength(1)
    expect(Array.from(writes[0])).toEqual([1])
    expect(callbacks.size).toBe(0)
    expect(cancelled).toEqual([1])
  })
})

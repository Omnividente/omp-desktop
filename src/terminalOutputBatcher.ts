export const TERMINAL_WRITE_BATCH_DELAY_MS = 16
export const MAX_TERMINAL_WRITE_BATCH = 256 * 1024

export interface TerminalOutputScheduler {
  schedule: (callback: () => void, delayMs: number) => number
  cancel: (handle: number) => void
}

export interface TerminalOutputBatcher {
  enqueue: (output: Uint8Array) => void
  flush: () => void
  dispose: () => void
}

export function createTerminalOutputBatcher(
  write: (output: Uint8Array) => void,
  scheduler: TerminalOutputScheduler,
  delayMs = TERMINAL_WRITE_BATCH_DELAY_MS,
  maxBytes = MAX_TERMINAL_WRITE_BATCH,
): TerminalOutputBatcher {
  let timer: number | null = null
  let chunks: Uint8Array[] = []
  let length = 0
  let disposed = false

  const clearTimer = () => {
    if (timer === null) return
    scheduler.cancel(timer)
    timer = null
  }

  const writePending = () => {
    if (disposed || length === 0) return

    const pending = chunks
    const pendingLength = length
    chunks = []
    length = 0
    if (pending.length === 1) {
      write(pending[0])
      return
    }

    const output = new Uint8Array(pendingLength)
    let offset = 0
    for (const chunk of pending) {
      output.set(chunk, offset)
      offset += chunk.length
    }
    write(output)
  }

  const endWindow = () => {
    timer = null
    writePending()
  }

  const scheduleWindow = () => {
    timer = scheduler.schedule(endWindow, delayMs)
  }

  const flush = () => {
    clearTimer()
    writePending()
  }

  const enqueue = (output: Uint8Array) => {
    if (disposed || output.length === 0) return
    if (timer === null && length === 0) {
      write(output)
      scheduleWindow()
      return
    }

    chunks.push(output)
    length += output.length
    if (length >= maxBytes) {
      clearTimer()
      writePending()
      scheduleWindow()
    }
  }

  const dispose = () => {
    disposed = true
    clearTimer()
    chunks = []
    length = 0
  }

  return { enqueue, flush, dispose }
}

import type { PtyOutputEvent, TerminalAttachment } from "./types"

export interface TerminalContinuityBaseline {
  generation: number
  lastSeq: number
}

export interface TerminalContinuityDecision {
  accept: boolean
  gap: boolean
  generationChanged: boolean
  expectedSeq: number
  receivedSeq: number
}

export interface TerminalAttachmentDecision {
  gap: boolean
  intentionalTruncation: boolean
  expectedSeq: number
  receivedSeq: number | null
}

const baselines = new Map<string, TerminalContinuityBaseline>()

export function terminalContinuityBaseline(terminalId: string): TerminalContinuityBaseline | null {
  return baselines.get(terminalId) ?? null
}

export function applyTerminalAttachment(
  terminalId: string,
  attachment: TerminalAttachment,
): TerminalAttachmentDecision {
  const previous = baselines.get(terminalId)
  const generationChanged = previous !== undefined && previous.generation !== attachment.generation
  const reset = attachment.baselineReset || generationChanged || previous === undefined
  const expectedSeq = reset ? 1 : previous.lastSeq + 1
  const receivedSeq = attachment.firstSeq
  const gap = !reset && !attachment.truncated && receivedSeq !== null && receivedSeq > expectedSeq
  const lastSeq =
    attachment.lastSeq ?? (reset ? Math.max(0, attachment.nextSeq - 1) : (previous?.lastSeq ?? 0))
  baselines.set(terminalId, {
    generation: attachment.generation,
    lastSeq: Math.max(reset ? 0 : (previous?.lastSeq ?? 0), lastSeq),
  })
  return {
    gap,
    intentionalTruncation: attachment.truncated,
    expectedSeq,
    receivedSeq,
  }
}

export function applyTerminalOutputEvent(event: PtyOutputEvent): TerminalContinuityDecision {
  const previous = baselines.get(event.terminalId)
  if (!previous) {
    baselines.set(event.terminalId, { generation: event.generation, lastSeq: event.seq })
    return {
      accept: true,
      gap: event.seq !== 1,
      generationChanged: false,
      expectedSeq: 1,
      receivedSeq: event.seq,
    }
  }
  if (previous.generation !== event.generation) {
    baselines.set(event.terminalId, { generation: event.generation, lastSeq: event.seq })
    return {
      accept: true,
      gap: true,
      generationChanged: true,
      expectedSeq: previous.lastSeq + 1,
      receivedSeq: event.seq,
    }
  }
  if (event.seq <= previous.lastSeq) {
    return {
      accept: false,
      gap: false,
      generationChanged: false,
      expectedSeq: previous.lastSeq + 1,
      receivedSeq: event.seq,
    }
  }
  const expectedSeq = previous.lastSeq + 1
  baselines.set(event.terminalId, { generation: event.generation, lastSeq: event.seq })
  return {
    accept: true,
    gap: event.seq !== expectedSeq,
    generationChanged: false,
    expectedSeq,
    receivedSeq: event.seq,
  }
}

export function forgetTerminalContinuity(terminalId: string): void {
  baselines.delete(terminalId)
}

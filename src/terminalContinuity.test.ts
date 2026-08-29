import { afterEach, describe, expect, it } from "vitest"
import {
  applyTerminalAttachment,
  applyTerminalOutputEvent,
  forgetTerminalContinuity,
  terminalContinuityBaseline,
} from "./terminalContinuity"
import type { TerminalAttachment } from "./types"

const terminalId = "terminal-continuity-test"

function attachment(overrides: Partial<TerminalAttachment> = {}): TerminalAttachment {
  return {
    data: "",
    generation: 11,
    firstSeq: null,
    lastSeq: null,
    nextSeq: 1,
    truncated: false,
    droppedBytes: 0,
    baselineReset: true,
    exited: false,
    exitCode: null,
    success: false,
    error: null,
    ...overrides,
  }
}

afterEach(() => forgetTerminalContinuity(terminalId))

describe("terminal output continuity", () => {
  it("preserves baseline across detach and accepts only unseen replay on reattach", () => {
    const initial = applyTerminalAttachment(
      terminalId,
      attachment({ firstSeq: 1, lastSeq: 1, nextSeq: 2 }),
    )
    expect(initial).toMatchObject({ gap: false, intentionalTruncation: false })

    const reattached = applyTerminalAttachment(
      terminalId,
      attachment({ firstSeq: 2, lastSeq: 2, nextSeq: 3, baselineReset: false }),
    )
    expect(reattached).toMatchObject({ gap: false, intentionalTruncation: false, expectedSeq: 2 })
    expect(terminalContinuityBaseline(terminalId)).toEqual({ generation: 11, lastSeq: 2 })

    expect(
      applyTerminalOutputEvent({ terminalId, data: "duplicate", generation: 11, seq: 2 }),
    ).toMatchObject({ accept: false, gap: false })
    expect(
      applyTerminalOutputEvent({ terminalId, data: "next", generation: 11, seq: 3 }),
    ).toMatchObject({ accept: true, gap: false, expectedSeq: 3 })
  })

  it("detects an unexpected gap inside one generation", () => {
    applyTerminalAttachment(terminalId, attachment())
    const decision = applyTerminalOutputEvent({
      terminalId,
      data: "late",
      generation: 11,
      seq: 2,
    })
    expect(decision).toMatchObject({ accept: true, gap: true, expectedSeq: 1, receivedSeq: 2 })
  })

  it("treats bounded detached replay truncation as intentional", () => {
    applyTerminalAttachment(terminalId, attachment({ firstSeq: 1, lastSeq: 1, nextSeq: 2 }))
    const decision = applyTerminalAttachment(
      terminalId,
      attachment({
        firstSeq: 4,
        lastSeq: 5,
        nextSeq: 6,
        truncated: true,
        droppedBytes: 4096,
        baselineReset: false,
      }),
    )
    expect(decision).toMatchObject({ gap: false, intentionalTruncation: true, expectedSeq: 2 })
    expect(terminalContinuityBaseline(terminalId)).toEqual({ generation: 11, lastSeq: 5 })
  })

  it("reports an unexpected generation replacement", () => {
    applyTerminalAttachment(terminalId, attachment({ firstSeq: 1, lastSeq: 1, nextSeq: 2 }))
    const decision = applyTerminalOutputEvent({
      terminalId,
      data: "new process",
      generation: 12,
      seq: 1,
    })
    expect(decision).toMatchObject({ accept: true, gap: true, generationChanged: true })
    expect(terminalContinuityBaseline(terminalId)).toEqual({ generation: 12, lastSeq: 1 })
  })

  it("resets the baseline when terminal close cleanup forgets it", () => {
    applyTerminalAttachment(terminalId, attachment({ firstSeq: 1, lastSeq: 3, nextSeq: 4 }))
    forgetTerminalContinuity(terminalId)
    expect(terminalContinuityBaseline(terminalId)).toBeNull()
    expect(
      applyTerminalOutputEvent({ terminalId, data: "replacement", generation: 12, seq: 1 }),
    ).toMatchObject({ accept: true, gap: false, generationChanged: false })
  })
})

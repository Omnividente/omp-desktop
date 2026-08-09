import { describe, expect, it } from "vitest"
import type { Terminal } from "@xterm/xterm"
import {
  createMouseSelectionEdit,
  cursorMoveInput,
  deleteInput,
  type TerminalCell,
} from "./terminalInput"

interface TerminalFixture {
  cols?: number
  rows?: number
  baseY?: number
  viewportY?: number
  cursorX?: number
  cursorY?: number
  wrappedRows?: number[]
}

function terminalFixture({
  cols = 80,
  rows = 24,
  baseY = 0,
  viewportY = baseY,
  cursorX = 11,
  cursorY = 0,
  wrappedRows = [],
}: TerminalFixture = {}): Terminal {
  const wrapped = new Set(wrappedRows)
  return {
    cols,
    rows,
    buffer: {
      active: {
        baseY,
        viewportY,
        cursorX,
        cursorY,
        getLine: (row: number) => ({ isWrapped: wrapped.has(row) }),
      },
    },
  } as unknown as Terminal
}

const left = "\x1b[D"
const right = "\x1b[C"
const forwardDelete = "\x1b[3~"

function range(startX: number, endX: number) {
  return { start: { x: startX, y: 0 }, end: { x: endX, y: 0 } }
}

describe("terminal desktop input editing", () => {
  it("moves the OMP editor cursor to a clicked cell", () => {
    const terminal = terminalFixture()
    expect(cursorMoveInput(terminal, { x: 5, y: 0 })).toBe(left.repeat(6))
    expect(cursorMoveInput(terminal, { x: 14, y: 0 })).toBe(right.repeat(3))
  })

  it("only crosses rows that belong to the same wrapped input line", () => {
    const target: TerminalCell = { x: 70, y: 0 }
    expect(cursorMoveInput(terminalFixture({ cursorX: 3, cursorY: 1 }), target)).toBeNull()
    expect(
      cursorMoveInput(terminalFixture({ cursorX: 3, cursorY: 1, wrappedRows: [1] }), target),
    ).toBe(left.repeat(13))
    expect(cursorMoveInput(terminalFixture({ viewportY: 1 }), { x: 5, y: 1 })).toBeNull()
  })

  it("deletes a forward mouse selection from its release endpoint", () => {
    const terminal = terminalFixture()
    const selection = createMouseSelectionEdit(terminal, range(6, 11), { x: 11, y: 0 }, "world")
    expect(selection).toEqual({ endpoint: { x: 11, y: 0 }, deleteBackward: true, length: 5 })
    expect(deleteInput(terminal, false, selection)).toBe("\x7f".repeat(5))
  })

  it("deletes a backward mouse selection without deleting adjacent text", () => {
    const terminal = terminalFixture()
    const selection = createMouseSelectionEdit(terminal, range(6, 11), { x: 6, y: 0 }, "world")
    expect(selection).toEqual({ endpoint: { x: 6, y: 0 }, deleteBackward: false, length: 5 })
    expect(deleteInput(terminal, false, selection)).toBe(left.repeat(5) + forwardDelete.repeat(5))
  })
  it("rejects explicit line breaks because no safe logical input boundary is available", () => {
    const terminal = terminalFixture({ cols: 20, cursorX: 4, cursorY: 2, wrappedRows: [2] })
    expect(cursorMoveInput(terminal, { x: 3, y: 0 })).toBeNull()
  })

  it("keeps wrapped cursor movement stable after a narrow resize", () => {
    const terminal = terminalFixture({ cols: 10, cursorX: 2, cursorY: 2, wrappedRows: [1, 2] })
    expect(cursorMoveInput(terminal, { x: 8, y: 0 })).toBe(left.repeat(14))
  })

  it("counts Unicode code points instead of UTF-16 units when deleting a selection", () => {
    const terminal = terminalFixture()
    const selection = createMouseSelectionEdit(terminal, range(6, 8), { x: 8, y: 0 }, "🙂я")
    expect(selection?.length).toBe(2)
    expect(deleteInput(terminal, false, selection)).toBe(left.repeat(3) + "\x7f".repeat(2))
  })

  it("maps Ctrl+A followed by delete to OMP's clear-editor chord", () => {
    expect(deleteInput(terminalFixture(), true, null)).toBe("\x03")
  })
})

import type { Terminal } from "@xterm/xterm"

const CURSOR_LEFT = "\x1b[D"
const CURSOR_RIGHT = "\x1b[C"
const DELETE_FORWARD = "\x1b[3~"
const DELETE_BACKWARD = "\x7f"
const CLEAR_OMP_EDITOR = "\x03"
const MAX_MOUSE_EDIT_ROWS = 8
const MAX_MOUSE_EDIT_CELLS = 4096

const UNSAFE_SELECTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
export interface TerminalCell {
  x: number
  y: number
}

export interface MouseSelectionEdit {
  endpoint: TerminalCell
  deleteBackward: boolean
  length: number
}

interface BufferRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export function formatSelectionReply(
  text: string,
  introduction: string,
  multiline: boolean,
): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(UNSAFE_SELECTION_CONTROLS, "")
    .split("\n")

  while (lines.length > 0 && lines[0].trim() === "") lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()
  if (lines.length === 0) return ""

  const heading = introduction.trim()
  if (!heading) return ""
  if (!multiline) {
    const compact = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ↵ ")
    return compact ? `${heading} “${compact}” — ` : ""
  }

  const quote = lines.map((line) => (line.trimEnd() ? `> ${line.trimEnd()}` : ">")).join("\n")
  return `${heading}\n\n${quote}\n\n`
}

export function bufferCellFromMouseEvent(
  terminal: Terminal,
  container: HTMLDivElement,
  event: MouseEvent,
): TerminalCell | null {
  const screen = container.querySelector<HTMLElement>(".xterm-screen")
  if (!screen) return null
  const bounds = screen.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null

  const x = Math.max(
    0,
    Math.min(
      terminal.cols - 1,
      Math.floor(((event.clientX - bounds.left) / bounds.width) * terminal.cols),
    ),
  )
  const viewportRow = Math.max(
    0,
    Math.min(
      terminal.rows - 1,
      Math.floor(((event.clientY - bounds.top) / bounds.height) * terminal.rows),
    ),
  )
  return { x, y: terminal.buffer.active.viewportY + viewportRow }
}

function sharesWrappedInputLine(terminal: Terminal, firstRow: number, secondRow: number): boolean {
  if (firstRow === secondRow) return true
  if (Math.abs(firstRow - secondRow) > MAX_MOUSE_EDIT_ROWS) return false
  const buffer = terminal.buffer.active
  const start = Math.min(firstRow, secondRow)
  const end = Math.max(firstRow, secondRow)
  for (let row = start + 1; row <= end; row += 1) {
    if (!buffer.getLine(row)?.isWrapped) return false
  }
  return true
}

export function cursorMoveInput(terminal: Terminal, target: TerminalCell): string | null {
  const buffer = terminal.buffer.active
  if (buffer.viewportY !== buffer.baseY) return null
  const cursor = { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY }
  if (
    target.y < buffer.baseY ||
    target.y >= buffer.baseY + terminal.rows ||
    !sharesWrappedInputLine(terminal, cursor.y, target.y)
  ) {
    return null
  }
  const distance = (target.y - cursor.y) * terminal.cols + target.x - cursor.x
  if (Math.abs(distance) > MAX_MOUSE_EDIT_CELLS) return null
  if (distance < 0) return CURSOR_LEFT.repeat(-distance)
  if (distance > 0) return CURSOR_RIGHT.repeat(distance)
  return ""
}

function cellIndex(terminal: Terminal, cell: TerminalCell): number {
  return cell.y * terminal.cols + cell.x
}

export function createMouseSelectionEdit(
  terminal: Terminal,
  range: BufferRange,
  releaseCell: TerminalCell,
  text: string,
): MouseSelectionEdit | null {
  // xterm 6.0 exposes the selection service's zero-based coordinates at runtime.
  const start = range.start
  const end = range.end
  const length = Array.from(text.replace(/[\r\n]/g, "")).length
  if (
    length === 0 ||
    length > MAX_MOUSE_EDIT_CELLS ||
    cursorMoveInput(terminal, start) === null ||
    cursorMoveInput(terminal, end) === null
  ) {
    return null
  }

  const releaseIndex = cellIndex(terminal, releaseCell)
  const startDistance = Math.abs(releaseIndex - cellIndex(terminal, start))
  const endDistance = Math.abs(releaseIndex - cellIndex(terminal, end))
  const endpoint = startDistance < endDistance ? start : end
  return {
    endpoint,
    deleteBackward: endpoint === end,
    length,
  }
}

export function deleteInput(
  terminal: Terminal,
  selectAllArmed: boolean,
  mouseSelection: MouseSelectionEdit | null,
): string | null {
  if (selectAllArmed) return CLEAR_OMP_EDITOR
  if (!mouseSelection) return null
  const move = cursorMoveInput(terminal, mouseSelection.endpoint)
  if (move === null) return null
  const deletion = mouseSelection.deleteBackward ? DELETE_BACKWARD : DELETE_FORWARD
  return move + deletion.repeat(mouseSelection.length)
}

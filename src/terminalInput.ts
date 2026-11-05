import type { Terminal } from "@xterm/xterm"
import type { TerminalTab } from "./types"

const CURSOR_LEFT = "\x1b[D"
const CURSOR_RIGHT = "\x1b[C"
const MAX_MOUSE_EDIT_ROWS = 8
const MAX_MOUSE_EDIT_CELLS = 4096

const UNSAFE_SELECTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
export interface TerminalCell {
  x: number
  y: number
}

export function terminalInputBlocked(
  tab: Pick<TerminalTab, "switching" | "primaryProviderPinPending" | "switchRecovery">,
): boolean {
  return tab.switching || tab.primaryProviderPinPending
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

  let first = 0
  let end = lines.length
  while (first < end && lines[first].trim() === "") first += 1
  while (end > first && lines[end - 1].trim() === "") end -= 1
  if (first === end) return ""

  const heading = introduction.trim()
  if (!heading) return ""
  if (!multiline) {
    const compact: string[] = []
    for (let index = first; index < end; index += 1) {
      const line = lines[index].trim()
      if (line) compact.push(line)
    }
    return compact.length ? `${heading} “${compact.join(" ↵ ")}” — ` : ""
  }

  const quote: string[] = []
  for (let index = first; index < end; index += 1) {
    const line = lines[index].trimEnd()
    quote.push(line ? `> ${line}` : ">")
  }
  return `${heading}\n\n${quote.join("\n")}\n\n`
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

function cursorInputDistance(terminal: Terminal, target: TerminalCell): number | null {
  const buffer = terminal.buffer.active
  if (buffer.viewportY !== buffer.baseY) return null
  const cursorY = buffer.baseY + buffer.cursorY
  if (
    target.y < buffer.baseY ||
    target.y >= buffer.baseY + terminal.rows ||
    !sharesWrappedInputLine(terminal, cursorY, target.y)
  ) {
    return null
  }
  const distance = (target.y - cursorY) * terminal.cols + target.x - buffer.cursorX
  return Math.abs(distance) > MAX_MOUSE_EDIT_CELLS ? null : distance
}

export function cursorMoveInput(terminal: Terminal, target: TerminalCell): string | null {
  const distance = cursorInputDistance(terminal, target)
  if (distance === null) return null
  if (distance < 0) return CURSOR_LEFT.repeat(-distance)
  if (distance > 0) return CURSOR_RIGHT.repeat(distance)
  return ""
}

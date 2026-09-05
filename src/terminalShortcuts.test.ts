import { describe, expect, it } from "vitest"
import { terminalShortcutInput } from "./terminalShortcuts"

type ShortcutEvent = Parameters<typeof terminalShortcutInput>[0]

const keydown: ShortcutEvent = {
  type: "keydown",
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
}

describe("agent terminal desktop shortcuts", () => {
  it("emits OMP undo rather than suspend without inventing redo or replacing yank", () => {
    expect(terminalShortcutInput({ ...keydown, key: "z", code: "KeyZ", ctrlKey: true }, true)).toBe(
      "\x1f",
    )
    expect(terminalShortcutInput({ ...keydown, key: "я", code: "KeyZ", metaKey: true }, true)).toBe(
      "\x1f",
    )
    expect(
      terminalShortcutInput({ ...keydown, key: "-", code: "Minus", ctrlKey: true }, true),
    ).toBe("\x1f")
    expect(
      terminalShortcutInput(
        { ...keydown, key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true },
        true,
      ),
    ).toBeNull()
    expect(
      terminalShortcutInput({ ...keydown, key: "y", code: "KeyY", ctrlKey: true }, true),
    ).toBeNull()
    expect(terminalShortcutInput({ ...keydown, key: "н", code: "KeyY", ctrlKey: true }, true)).toBe(
      "\x19",
    )
  })

  it("preserves editing distinctions and physical Ctrl keys across layouts", () => {
    const cases: [Partial<ShortcutEvent>, string][] = [
      [{ key: "я", code: "KeyZ", ctrlKey: true }, "\x1f"],
      [{ key: "Backspace", code: "Backspace", ctrlKey: true }, "\x1b[127;5u"],
      [{ key: "Delete", code: "Delete", ctrlKey: true }, "\x1b[3;3~"],
      [{ key: "Enter", code: "Enter", shiftKey: true }, "\x1b[13;2u"],
      [{ key: "Enter", code: "NumpadEnter", ctrlKey: true }, "\x1b[13;5u"],
      [{ key: "ц", code: "KeyW", ctrlKey: true }, "\x17"],
      [{ key: "Г", code: "KeyU", ctrlKey: true }, "\x15"],
      [{ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true }, "\x1b[111;6u"],
      [{ key: "З", code: "KeyP", ctrlKey: true, shiftKey: true }, "\x1b[112;6u"],
      [{ key: "ю", code: "Period", ctrlKey: true }, "\x1b[46;5u"],
    ]
    for (const [event, input] of cases) {
      expect(terminalShortcutInput({ ...keydown, ...event }, true)).toBe(input)
      expect(terminalShortcutInput({ ...keydown, ...event }, false)).toBeNull()
    }
  })

  it("leaves composition, AltGr, clipboard, releases and reliable xterm navigation untouched", () => {
    const unchanged: Partial<ShortcutEvent>[] = [
      { key: "я", code: "KeyZ" },
      { key: "я", code: "KeyZ", ctrlKey: true, altKey: true },
      { key: "я", code: "KeyZ", ctrlKey: true, isComposing: true },
      { key: "Dead", code: "KeyZ", ctrlKey: true },
      { key: "Process", code: "KeyZ", ctrlKey: true },
      { key: "Unidentified", code: "KeyZ", ctrlKey: true },
      { key: "z", code: "KeyZ", ctrlKey: true, metaKey: true },
      { type: "keyup", key: "z", code: "KeyZ", ctrlKey: true },
      { type: "keypress", key: "z", code: "KeyZ", ctrlKey: true },
      { key: "м", code: "KeyV", ctrlKey: true },
      { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true },
      { key: "w", code: "KeyW", ctrlKey: true },
      { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true },
      { key: "ArrowRight", code: "ArrowRight", altKey: true },
      { key: "Home", code: "Home", ctrlKey: true },
      { key: "End", code: "End", ctrlKey: true, shiftKey: true },
      { key: "Enter", code: "Enter" },
    ]
    for (const event of unchanged) {
      expect(terminalShortcutInput({ ...keydown, ...event }, true)).toBeNull()
    }
  })
})

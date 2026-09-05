type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
>

/**
 * Translate only desktop editing aliases and key distinctions xterm loses.
 * Call from the agent terminal's key handler after selection/clipboard handling,
 * never from ordinary DOM inputs. A string is PTY input: consume the DOM event
 * and send it once. null leaves xterm/browser behavior untouched.
 *
 * OMP binds undo to Ctrl+_ (US), not Ctrl+Z (suspend), and has no redo command.
 * Ctrl+Delete aliases OMP's Alt+Delete word deletion. CSI-u preserves modified
 * Enter/Backspace and Ctrl+Shift+O/P; OMP parses it without Kitty negotiation.
 * Ctrl+Enter keeps OMP's follow-up binding, not an invented submit/newline alias.
 * Ctrl/Alt navigation already has distinct xterm sequences and is not rewritten.
 */
export function terminalShortcutInput(
  event: TerminalShortcutEvent,
  isAgent: boolean,
): string | null {
  if (
    !isAgent ||
    event.type !== "keydown" ||
    event.isComposing ||
    event.key === "Dead" ||
    event.key === "Process" ||
    event.key === "Unidentified" ||
    event.altKey ||
    (event.ctrlKey && event.metaKey)
  ) {
    return null
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === "KeyZ") {
    return "\x1f"
  }
  if (event.metaKey) return null

  if (event.code === "Enter" || event.code === "NumpadEnter") {
    if (event.shiftKey && !event.ctrlKey) return "\x1b[13;2u"
    if (event.ctrlKey && !event.shiftKey) return "\x1b[13;5u"
    return null
  }
  if (!event.ctrlKey) return null

  if (event.shiftKey) {
    // These OMP bindings are lost by xterm's legacy Ctrl+letter encoder.
    if (event.code === "KeyO") return "\x1b[111;6u"
    if (event.code === "KeyP") return "\x1b[112;6u"
    return null
  }

  switch (event.code) {
    case "Backspace":
      // Raw BS is plain Backspace outside a genuine Windows Terminal session.
      return "\x1b[127;5u"
    case "Delete":
      return "\x1b[3;3~"
    case "Minus":
      return "\x1f"
    case "Period":
      return "\x1b[46;5u"
    case "KeyV":
      // Clipboard ownership stays with the caller, including alternate layouts.
      return null
  }

  // xterm uses legacy keyCode; physical letters keep Ctrl chords available on
  // non-Latin layouts. Leave its reliable ASCII encoding alone (including yank).
  if (event.code.length === 4 && event.code.startsWith("Key")) {
    const physicalLetter = event.code.charCodeAt(3)
    if (physicalLetter >= 65 && physicalLetter <= 90) {
      const key = event.key.charCodeAt(0)
      if (event.key.length === 1 && (key === physicalLetter || key === physicalLetter + 32)) {
        return null
      }
      return String.fromCharCode(physicalLetter - 64)
    }
  }

  return null
}

import { useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import {
  attachTerminal,
  detachTerminal,
  errorMessage,
  openContentLink,
  resizeTerminal,
  writeTerminal,
  writeTerminalBinary,
} from "./api"
import { Icon } from "./Icon"
import {
  bufferCellFromMouseEvent,
  createMouseSelectionEdit,
  cursorMoveInput,
  deleteInput,
  formatSelectionReply,
  type MouseSelectionEdit,
  type TerminalCell,
  terminalInputBlocked,
} from "./terminalInput"
import { createTerminalOutputBatcher } from "./terminalOutputBatcher"
import {
  applyTerminalAttachment,
  applyTerminalOutputEvent,
  terminalContinuityBaseline,
} from "./terminalContinuity"
import { formatTerminalExitLine } from "./uiUtils"
import type { PtyExitEvent, PtyOutputEvent, RuntimeInfo, TerminalTab } from "./types"
import { t, type Lang } from "./i18n"
import { CONTENT_URL_PATTERN, isContentLink } from "./contentLinks"
import { terminalShortcutInput } from "./terminalShortcuts"

// The xterm addon adds its own global flag when scanning wrapped lines.
const TERMINAL_URL_PATTERN = new RegExp(CONTENT_URL_PATTERN.source, "i")

interface TerminalViewProps {
  tab: TerminalTab
  active: boolean
  focusRequestSequence: number
  language: Lang
  terminalFontFamily: string
  terminalFontSize: number
  platform: RuntimeInfo["platform"]
  onExit: (event: PtyExitEvent) => void
  onError: (message: string) => void
  onReady: (terminalId: string) => void
}

interface SelectionReplyAction {
  text: string
  left: number
  top: number
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function TerminalView({
  tab,
  active,
  focusRequestSequence,
  language,
  terminalFontFamily,
  terminalFontSize,
  platform,
  onExit,
  onError,
  onReady,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [inputSelectionArmed, setInputSelectionArmed] = useState(false)
  const [inputHelpOpen, setInputHelpOpen] = useState(false)
  const [selectionReply, setSelectionReply] = useState<SelectionReplyAction | null>(null)
  const [linkPreview, setLinkPreview] = useState<string | null>(null)
  const selectAllArmedRef = useRef(false)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const languageRef = useRef(language)
  const terminalFontFamilyRef = useRef(terminalFontFamily)
  const terminalFontSizeRef = useRef(terminalFontSize)
  const onExitRef = useRef(onExit)
  const onErrorRef = useRef(onError)
  const onReadyRef = useRef(onReady)
  const inputBlockedRef = useRef(terminalInputBlocked(tab))
  const sessionPathRef = useRef(tab.sessionPath)

  activeRef.current = active
  languageRef.current = language
  terminalFontFamilyRef.current = terminalFontFamily
  terminalFontSizeRef.current = terminalFontSize
  onExitRef.current = onExit
  onErrorRef.current = onError
  onReadyRef.current = onReady
  inputBlockedRef.current = terminalInputBlocked(tab)
  sessionPathRef.current = tab.sessionPath

  const replyToSelection = () => {
    const terminal = terminalRef.current
    if (!terminal || !selectionReply) return
    const input = formatSelectionReply(
      selectionReply.text,
      t(language, "terminalReplyContext"),
      terminal.modes.bracketedPasteMode,
    )
    if (!input) return
    terminal.paste(input)
    terminal.clearSelection()
    setSelectionReply(null)
    window.requestAnimationFrame(() => terminal.focus())
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const isLinuxRuntime = platform === "linux"
    let hoveredLink: string | null = null
    const leaveLink = () => {
      hoveredLink = null
      setLinkPreview(null)
    }
    const hoverLink = (_event: MouseEvent, uri: string) => {
      hoveredLink = uri
      setLinkPreview(uri)
    }
    const activateLink = (event: MouseEvent, uri: string) => {
      event.preventDefault()
      event.stopPropagation()
      if (terminal.hasSelection() || (event.button !== 0 && event.button !== 1)) return
      if (!isContentLink(uri)) {
        onErrorRef.current(t(languageRef.current, "contentLinkUnsupported"))
        return
      }
      void openContentLink(uri, sessionPathRef.current).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current, { includeDetails: true }))
      })
    }
    const terminal = new Terminal({
      cursorBlink: !isLinuxRuntime,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: terminalFontFamilyRef.current,
      fontSize: terminalFontSizeRef.current,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: 12_000,
      smoothScrollDuration: isLinuxRuntime ? 0 : 90,
      linkHandler: {
        activate: activateLink,
        hover: hoverLink,
        leave: leaveLink,
        allowNonHttpProtocols: true,
      },
      theme: {
        background: "#101312",
        foreground: "#d9dedb",
        cursor: "#b9f27c",
        cursorAccent: "#101312",
        selectionBackground: "#769e63e6",
        selectionForeground: "#0c120d",
        selectionInactiveBackground: "#3d5a46cc",
        black: "#151817",
        red: "#ef7070",
        green: "#81c995",
        yellow: "#e7bd72",
        blue: "#79a7e3",
        magenta: "#c49ae8",
        cyan: "#6fc9c2",
        white: "#d9dedb",
        brightBlack: "#6d7671",
        brightRed: "#ff8b8b",
        brightGreen: "#a7df95",
        brightYellow: "#f3d58c",
        brightBlue: "#9bbdf0",
        brightMagenta: "#d7b2f2",
        brightCyan: "#8ddbd4",
        brightWhite: "#f6f8f7",
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(
      new WebLinksAddon(activateLink, {
        urlRegex: TERMINAL_URL_PATTERN,
        hover: hoverLink,
        leave: leaveLink,
      }),
    )
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    let pointerDownCell: TerminalCell | null = null
    let mouseSelection: MouseSelectionEdit | null = null
    const clearArmedSelection = () => {
      selectAllArmedRef.current = false
      setInputSelectionArmed(false)
      mouseSelection = null
    }
    const sendInput = (data: string) => {
      if (inputBlockedRef.current) return
      void writeTerminal(tab.id, data).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current))
      })
    }
    const showSelectionReply = (event: MouseEvent, text: string) => {
      if (tab.kind !== "agent" || !text.trim()) {
        setSelectionReply(null)
        return
      }
      const view = container.parentElement
      if (!view) return
      const bounds = view.getBoundingClientRect()
      const actionWidth = 92
      const actionGap = 10
      const pointerX = event.clientX - bounds.left
      const pointerY = event.clientY - bounds.top
      const horizontalOffset = actionWidth / 2 + actionGap
      const placeRight = pointerX + actionWidth + actionGap <= bounds.width
      const left = Math.min(
        Math.max(
          pointerX + (placeRight ? horizontalOffset : -horizontalOffset),
          actionWidth / 2 + 8,
        ),
        bounds.width - actionWidth / 2 - 8,
      )
      const top = Math.min(Math.max(pointerY, 20), Math.max(20, bounds.height - 20))
      setSelectionReply({ text, left, top })
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) return true
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      const consume = () => {
        event.preventDefault()
        event.stopPropagation()
        return false
      }
      const copyShortcut = modifier && (event.code === "KeyC" || event.code === "Insert")
      if (copyShortcut && terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection) {
          void writeText(selection).catch((error) => {
            onErrorRef.current(errorMessage(error, languageRef.current))
          })
          return consume()
        }
      }

      if (
        tab.kind === "agent" &&
        ((modifier && event.code === "KeyV") ||
          (event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            event.code === "Insert"))
      ) {
        // Let OMP read the clipboard, including images. Suppress the WebView's
        // paste event so it cannot also insert a second copy of the same text.
        clearArmedSelection()
        terminal.clearSelection()
        sendInput(event.shiftKey && modifier ? "\x1b[118;6u" : "\x16")
        return consume()
      }

      if (
        tab.kind === "agent" &&
        modifier &&
        !event.altKey &&
        !event.shiftKey &&
        event.code === "KeyA"
      ) {
        selectAllArmedRef.current = true
        setInputSelectionArmed(true)
        mouseSelection = null
        setSelectionReply(null)
        terminal.clearSelection()
        return consume()
      }

      const deleteSelection = event.code === "Backspace" || event.code === "Delete"
      if (tab.kind === "agent" && deleteSelection) {
        const selectAllArmed = selectAllArmedRef.current
        const input =
          selectAllArmed || (terminal.hasSelection() && mouseSelection)
            ? deleteInput(terminal, selectAllArmed, mouseSelection)
            : null
        if (input !== null) {
          clearArmedSelection()
          terminal.clearSelection()
          sendInput(input)
          return consume()
        }
      }

      if (selectAllArmedRef.current) clearArmedSelection()
      if (!terminal.hasSelection()) mouseSelection = null
      const shortcut = terminalShortcutInput(event, tab.kind === "agent")
      if (shortcut !== null) {
        sendInput(shortcut)
        return consume()
      }
      return true
    })

    const handleFocusOut = (event: FocusEvent) => {
      if (!container.contains(event.relatedTarget as Node | null)) clearArmedSelection()
    }
    const handleMouseDown = (event: MouseEvent) => {
      terminal.focus()
      clearArmedSelection()
      setSelectionReply(null)
      if (hoveredLink !== null) {
        pointerDownCell = null
        return
      }
      pointerDownCell =
        event.button === 0 && terminal.modes.mouseTrackingMode === "none"
          ? bufferCellFromMouseEvent(terminal, container, event)
          : null
    }
    const handleMouseUp = (event: MouseEvent) => {
      if (hoveredLink !== null) {
        pointerDownCell = null
        return
      }
      const releaseCell =
        event.button === 0 && terminal.modes.mouseTrackingMode === "none"
          ? bufferCellFromMouseEvent(terminal, container, event)
          : null
      if (!pointerDownCell || !releaseCell) {
        pointerDownCell = null
        return
      }

      if (terminal.hasSelection()) {
        const range = terminal.getSelectionPosition()
        const text = terminal.getSelection()
        if (range && text) {
          mouseSelection = createMouseSelectionEdit(terminal, range, releaseCell, text)
          showSelectionReply(event, text)
        }
      } else if (pointerDownCell.x === releaseCell.x && pointerDownCell.y === releaseCell.y) {
        setSelectionReply(null)
        const move = cursorMoveInput(terminal, releaseCell)
        if (move) sendInput(move)
      }
      pointerDownCell = null
    }
    const handleContextMenu = (event: MouseEvent) => {
      if (tab.kind !== "agent" || !terminal.hasSelection()) return
      const text = terminal.getSelection()
      if (!text.trim()) return
      event.preventDefault()
      showSelectionReply(event, text)
    }
    container.addEventListener("mousedown", handleMouseDown)
    container.addEventListener("contextmenu", handleContextMenu)
    container.addEventListener("mouseup", handleMouseUp)
    container.addEventListener("focusout", handleFocusOut)
    const selectionSubscription = terminal.onSelectionChange(() => {
      if (!terminal.hasSelection()) setSelectionReply(null)
    })
    const scrollSubscription = terminal.onScroll(() => {
      setSelectionReply(null)
      leaveLink()
    })

    let disposed = false
    let lastCols = 0
    let lastRows = 0
    const unlisteners: UnlistenFn[] = []
    const attachmentId =
      globalThis.crypto?.randomUUID?.() ??
      `${tab.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const outputBatcher = createTerminalOutputBatcher((output) => terminal.write(output), {
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (handle) => window.clearTimeout(handle),
    })
    let deferredOutput: PtyOutputEvent[] = []
    let outputReady = false
    let exitHandled = false
    let deferredExit: PtyExitEvent | null = null

    const reportOutputGap = (expected: number, received: number) => {
      onErrorRef.current(
        t(languageRef.current, "terminalOutputGap")
          .replace("{expected}", String(expected))
          .replace("{received}", String(received)),
      )
    }
    const handleOutputEvent = (event: PtyOutputEvent) => {
      const decision = applyTerminalOutputEvent(event)
      if (decision.generationChanged) {
        onErrorRef.current(t(languageRef.current, "terminalOutputGenerationChanged"))
      } else if (decision.gap) {
        reportOutputGap(decision.expectedSeq, decision.receivedSeq)
      }
      if (decision.accept && event.data) outputBatcher.enqueue(decodeBase64(event.data))
    }
    const queueOutput = (event: PtyOutputEvent) => {
      if (outputReady) handleOutputEvent(event)
      else deferredOutput.push(event)
    }

    const handleExit = (event: PtyExitEvent) => {
      if (exitHandled) {
        return
      }
      exitHandled = true
      outputBatcher.flush()
      terminal.write(formatTerminalExitLine(event, languageRef.current))
      onExitRef.current(event)
    }

    const fit = () => {
      if (disposed || !activeRef.current || container.clientWidth === 0) {
        return
      }
      try {
        fitAddon.fit()
        if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
          lastCols = terminal.cols
          lastRows = terminal.rows
          void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(() => undefined)
        }
      } catch {
        // The webview can report a zero-sized container during a tab switch.
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fit)
    })
    resizeObserver.observe(container)

    const dataSubscription = terminal.onData(sendInput)
    const binarySubscription = terminal.onBinary((data) => {
      if (inputBlockedRef.current) return
      void writeTerminalBinary(tab.id, btoa(data)).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current))
      })
    })

    const connect = async () => {
      const stopOutput = await listen<PtyOutputEvent>(`pty-output:${tab.id}`, ({ payload }) => {
        if (!disposed) queueOutput(payload)
      })
      if (disposed) {
        stopOutput()
        return
      }
      unlisteners.push(stopOutput)

      const stopExit = await listen<PtyExitEvent>("pty-exit", ({ payload }) => {
        if (!disposed && payload.terminalId === tab.id) {
          if (outputReady) {
            handleExit(payload)
          } else {
            deferredExit = payload
          }
        }
      })
      if (disposed) {
        stopExit()
        return
      }
      unlisteners.push(stopExit)

      const baseline = terminalContinuityBaseline(tab.id)
      const attachment = await attachTerminal(
        tab.id,
        attachmentId,
        baseline?.generation ?? null,
        baseline?.lastSeq ?? null,
      )
      if (disposed) {
        void detachTerminal(tab.id, attachmentId).catch(() => undefined)
        return
      }
      const continuity = applyTerminalAttachment(tab.id, attachment)
      if (continuity.gap && continuity.receivedSeq !== null) {
        reportOutputGap(continuity.expectedSeq, continuity.receivedSeq)
      }
      if (attachment.truncated) {
        terminal.write(
          `\r\n\x1b[33m${t(languageRef.current, "terminalOutputTruncated").replace(
            "{bytes}",
            String(attachment.droppedBytes),
          )}\x1b[0m\r\n`,
        )
      }
      if (attachment.data) terminal.write(decodeBase64(attachment.data))
      outputReady = true
      for (const output of deferredOutput) handleOutputEvent(output)
      deferredOutput = []
      outputBatcher.flush()
      if (attachment.exited) {
        handleExit({
          terminalId: tab.id,
          exitCode: attachment.exitCode,
          success: attachment.success,
          error: attachment.error,
        })
      } else if (deferredExit) {
        handleExit(deferredExit)
      } else {
        onReadyRef.current(tab.id)
      }
      window.requestAnimationFrame(() => {
        fit()
        if (activeRef.current) terminal.focus()
      })
    }

    void connect().catch((error) => {
      if (!disposed) {
        onErrorRef.current(errorMessage(error, languageRef.current))
      }
    })

    return () => {
      disposed = true
      void detachTerminal(tab.id, attachmentId).catch(() => undefined)
      outputBatcher.dispose()
      deferredOutput = []
      resizeObserver.disconnect()
      container.removeEventListener("mousedown", handleMouseDown)
      container.removeEventListener("mouseup", handleMouseUp)
      container.removeEventListener("focusout", handleFocusOut)
      container.removeEventListener("contextmenu", handleContextMenu)
      selectAllArmedRef.current = false
      dataSubscription.dispose()
      binarySubscription.dispose()
      selectionSubscription.dispose()
      scrollSubscription.dispose()
      for (const unlisten of unlisteners) {
        unlisten()
      }
      fitAddonRef.current = null
      terminalRef.current = null
      terminal.dispose()
    }
  }, [platform, tab.id, tab.kind])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontFamily = terminalFontFamily
    terminal.options.fontSize = terminalFontSize
    window.requestAnimationFrame(() => fitAddonRef.current?.fit())
  }, [terminalFontFamily, terminalFontSize])

  useEffect(() => {
    if (!active) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
        terminalRef.current?.focus()
        const terminal = terminalRef.current
        if (terminal) {
          void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(() => undefined)
        }
      } catch {
        // A hidden terminal can briefly be zero-sized while the tab becomes active.
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, focusRequestSequence, tab.id])

  useEffect(() => {
    if (active) return
    selectAllArmedRef.current = false
    setInputHelpOpen(false)
    setInputSelectionArmed(false)
    setSelectionReply(null)
    setLinkPreview(null)
  }, [active])

  return (
    <div
      className={`terminal-view${active ? " is-active" : ""}`}
      onMouseDown={() => terminalRef.current?.focus()}
    >
      <div className="terminal-host" ref={containerRef} />
      {linkPreview && (
        <div className="terminal-link-preview" role="status">
          {linkPreview}
        </div>
      )}
      {tab.kind === "agent" && selectionReply && (
        <button
          aria-label={t(language, "terminalReplyToSelection")}
          className="terminal-selection-reply"
          onClick={replyToSelection}
          onMouseDown={(event) => event.stopPropagation()}
          style={{ left: selectionReply.left, top: selectionReply.top }}
          title={t(language, "terminalReplyToSelection")}
          type="button"
        >
          <Icon name="reply" size={13} />
          <span>{t(language, "terminalReplyToSelection")}</span>
        </button>
      )}
      {tab.kind === "agent" && (
        <button
          aria-expanded={inputHelpOpen}
          aria-label={t(language, "terminalInputHelp")}
          className="terminal-input-help-trigger"
          onClick={() => setInputHelpOpen((current) => !current)}
          title={t(language, "terminalInputHelp")}
          type="button"
        >
          <Icon name="command" size={13} />
        </button>
      )}
      {tab.kind === "agent" && inputHelpOpen && (
        <div className="terminal-input-help" role="note">
          {t(language, "terminalInputHelp")}
        </div>
      )}
      {tab.kind === "agent" && inputSelectionArmed && (
        <div aria-live="polite" className="terminal-input-selected" role="status">
          {t(language, "terminalInputSelected")}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  attachTerminal,
  errorMessage,
  resizeTerminal,
  writeTerminal,
  writeTerminalBinary,
} from "./api";
import type { PtyExitEvent, PtyOutputEvent, TerminalTab } from "./types";
import type { Lang } from "./i18n";

interface TerminalViewProps {
  tab: TerminalTab;
  active: boolean;
  language: Lang;
  terminalFontFamily: string;
  terminalFontSize: number;
  onExit: (event: PtyExitEvent) => void;
  onError: (message: string) => void;
  onReady: (terminalId: string) => void;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function exitLine(event: PtyExitEvent): string {
  if (event.error) {
    return `\r\n\x1b[38;2;239;112;112mOMP завершён: ${event.error}\x1b[0m\r\n`;
  }
  const color = event.success ? "129;201;149" : "239;170;103";
  const code = event.exitCode ?? "?";
  return `\r\n\x1b[38;2;${color}mПроцесс OMP завершён · код ${code}\x1b[0m\r\n`;
}

export function TerminalView({
  tab,
  active,
  language,
  terminalFontFamily,
  terminalFontSize,
  onExit,
  onError,
  onReady,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const languageRef = useRef(language);
  const terminalFontFamilyRef = useRef(terminalFontFamily);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);

  activeRef.current = active;
  languageRef.current = language;
  terminalFontFamilyRef.current = terminalFontFamily;
  terminalFontSizeRef.current = terminalFontSize;
  onExitRef.current = onExit;
  onErrorRef.current = onError;
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: terminalFontFamilyRef.current,
      fontSize: terminalFontSizeRef.current,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: 12_000,
      smoothScrollDuration: 90,
      theme: {
        background: "#101312",
        foreground: "#d9dedb",
        cursor: "#b9f27c",
        cursorAccent: "#101312",
        selectionBackground: "#3f594866",
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
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      const copyShortcut =
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.code === "KeyC";
      if (!copyShortcut || !terminal.hasSelection()) {
        return true;
      }

      const selection = terminal.getSelection();
      if (!selection) {
        return true;
      }
      void writeText(selection).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current));
      });
      return false;
    });

    let disposed = false;
    let lastCols = 0;
    let lastRows = 0;
    const unlisteners: UnlistenFn[] = [];

    const fit = () => {
      if (disposed || !activeRef.current || container.clientWidth === 0) {
        return;
      }
      try {
        fitAddon.fit();
        if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
          lastCols = terminal.cols;
          lastRows = terminal.rows;
          void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(() => undefined);
        }
      } catch {
        // The webview can report a zero-sized container during a tab switch.
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fit);
    });
    resizeObserver.observe(container);

    const dataSubscription = terminal.onData((data) => {
      void writeTerminal(tab.id, data).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current));
      });
    });
    const binarySubscription = terminal.onBinary((data) => {
      void writeTerminalBinary(tab.id, btoa(data)).catch((error) => {
        onErrorRef.current(errorMessage(error, languageRef.current));
      });
    });

    const connect = async () => {
      const stopOutput = await listen<PtyOutputEvent>(
        `pty-output:${tab.id}`,
        ({ payload }) => {
          if (!disposed && payload.data) {
            terminal.write(decodeBase64(payload.data));
          }
        },
      );
      if (disposed) {
        stopOutput();
        return;
      }
      unlisteners.push(stopOutput);

      const stopExit = await listen<PtyExitEvent>("pty-exit", ({ payload }) => {
        if (!disposed && payload.terminalId === tab.id) {
          terminal.write(exitLine(payload));
          onExitRef.current(payload);
        }
      });
      if (disposed) {
        stopExit();
        return;
      }
      unlisteners.push(stopExit);

      const attachment = await attachTerminal(tab.id);
      if (disposed) {
        return;
      }
      if (attachment.data) {
        terminal.write(decodeBase64(attachment.data));
      }
      if (attachment.exited) {
        const event: PtyExitEvent = {
          terminalId: tab.id,
          exitCode: attachment.exitCode,
          success: attachment.success,
          error: attachment.error,
        };
        terminal.write(exitLine(event));
        onExitRef.current(event);
      }
      if (!attachment.exited) {
        onReadyRef.current(tab.id);
      }
      window.requestAnimationFrame(() => {
        fit();
        if (activeRef.current) {
          terminal.focus();
        }
      });
    };

    void connect().catch((error) => {
      if (!disposed) {
        onErrorRef.current(errorMessage(error, languageRef.current));
      }
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      dataSubscription.dispose();
      binarySubscription.dispose();
      for (const unlisten of unlisteners) {
        unlisten();
      }
      fitAddonRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [tab.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = terminalFontFamily;
    terminal.options.fontSize = terminalFontSize;
    window.requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [terminalFontFamily, terminalFontSize]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
        const terminal = terminalRef.current;
        if (terminal) {
          void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(() => undefined);
        }
      } catch {
        // A hidden terminal can briefly be zero-sized while the tab becomes active.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, tab.id]);

  return (
    <div
      className={`terminal-view${active ? " is-active" : ""}`}
      onMouseDown={() => terminalRef.current?.focus()}
      ref={containerRef}
    />
  );
}

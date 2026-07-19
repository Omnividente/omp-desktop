import { invoke } from "@tauri-apps/api/core";
import type {
  BootstrapPayload,
  SettingsUpdate,
  TerminalAttachment,
  TerminalStarted,
} from "./types";

export function bootstrap(): Promise<BootstrapPayload> {
  return invoke("bootstrap");
}

export function addWorkspace(path: string): Promise<BootstrapPayload> {
  return invoke("add_workspace", { path });
}

export function updateSettings(
  update: SettingsUpdate,
): Promise<BootstrapPayload> {
  return invoke("update_settings", { update });
}

export function startTerminal(
  cwd: string,
  resumePath: string | null,
  cols = 120,
  rows = 36,
): Promise<TerminalStarted> {
  return invoke("start_terminal", {
    request: { cwd, resumePath, cols, rows },
  });
}

export function attachTerminal(
  terminalId: string,
): Promise<TerminalAttachment> {
  return invoke("attach_terminal", { terminalId });
}

export function writeTerminal(
  terminalId: string,
  data: string,
): Promise<void> {
  return invoke("write_terminal", { terminalId, data });
}

export function writeTerminalBinary(
  terminalId: string,
  data: number[],
): Promise<void> {
  return invoke("write_terminal_binary", { terminalId, data });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("close_terminal", { terminalId });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Неизвестная ошибка";
}

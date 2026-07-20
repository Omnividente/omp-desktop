import { invoke } from "@tauri-apps/api/core";
import type {
  BootstrapPayload,
  CodexSessionSummary,
  OmpConfigSaveRequest,
  OmpConfigSnapshot,
  OmpUpdateInfo,
  SettingsUpdate,
  TerminalAttachment,
  TerminalStarted,
  TerminalRuntime,
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
  args: string[] | null = null,
): Promise<TerminalStarted> {
  return invoke("start_terminal", {
    request: { cwd, resumePath, cols, rows, args },
  });
}

export function switchTerminal(
  terminalId: string,
  modelSelector: string,
  thinkingLevel: string | null,
  supportedThinking: string[],
  currentModel: string | null,
  currentThinking: string | null,
  currentThinkingConfigured: string | null,
): Promise<TerminalRuntime> {
  return invoke("switch_terminal", {
    request: {
      terminalId,
      modelSelector,
      thinkingLevel,
      supportedThinking,
      currentModel,
      currentThinking,
      currentThinkingConfigured,
    },
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

export function renameSession(
  path: string,
  title: string,
): Promise<BootstrapPayload> {
  return invoke("rename_session", { path, title });
}

export function importSession(
  path: string,
  targetCwd: string,
): Promise<BootstrapPayload> {
  return invoke("import_session", { path, targetCwd });
}

export function listCodexSessions(): Promise<CodexSessionSummary[]> {
  return invoke("list_codex_sessions");
}

export function loadOmpConfig(): Promise<OmpConfigSnapshot> {
  return invoke("load_omp_config");
}

export function saveOmpConfig(
  request: OmpConfigSaveRequest,
): Promise<OmpConfigSnapshot> {
  return invoke("save_omp_config", { request });
}

export function checkOmpUpdate(): Promise<OmpUpdateInfo> {
  return invoke("check_omp_update");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

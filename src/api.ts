import { invoke } from "@tauri-apps/api/core"
import type {
  BootstrapPayload,
  CodexSessionSummary,
  ImportBatchPayload,
  ImportSessionRequest,
  OmpConfigSnapshot,
  OmpUpdateInfo,
  SessionTranscript,
  ResourceHealthSnapshot,
  SettingsSavePayload,
  SettingsSaveRequest,
  TerminalAttachment,
  TerminalStarted,
  TerminalRuntime,
} from "./types"
import type { Lang } from "./i18n"

export function bootstrap(): Promise<BootstrapPayload> {
  return invoke("bootstrap")
}

export function addWorkspace(path: string): Promise<BootstrapPayload> {
  return invoke("add_workspace", { path })
}

export function saveSettingsBundle(request: SettingsSaveRequest): Promise<SettingsSavePayload> {
  return invoke("save_settings_bundle", { request })
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
  })
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
  })
}

export function attachTerminal(terminalId: string): Promise<TerminalAttachment> {
  return invoke("attach_terminal", { terminalId })
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("write_terminal", { terminalId, data })
}

export function writeTerminalBinary(terminalId: string, data: string): Promise<void> {
  return invoke("write_terminal_binary", { terminalId, data })
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows })
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("close_terminal", { terminalId })
}

export function setSessionTitlePin(path: string, title: string | null): Promise<BootstrapPayload> {
  return invoke("set_session_title_pin", { path, title })
}

export function deleteSession(path: string): Promise<BootstrapPayload> {
  return invoke("delete_session", { path })
}

export function readSessionTranscript(path: string): Promise<SessionTranscript> {
  return invoke("read_session_transcript", { path })
}

export function importSessions(requests: ImportSessionRequest[]): Promise<ImportBatchPayload> {
  return invoke("import_sessions", { requests })
}

export function listCodexSessions(): Promise<CodexSessionSummary[]> {
  return invoke("list_codex_sessions")
}

export function loadOmpConfig(): Promise<OmpConfigSnapshot> {
  return invoke("load_omp_config")
}

export function checkOmpUpdate(): Promise<OmpUpdateInfo> {
  return invoke("check_omp_update")
}

export function sampleResourceHealth(
  workspacePath: string | null,
): Promise<ResourceHealthSnapshot> {
  return invoke("sample_resource_health", { workspacePath })
}

interface BackendError {
  code?: string
  message?: string
  details?: string
}

const BACKEND_ERROR_TEXT: Record<string, Record<Lang, string>> = {
  backend_join_failed: {
    ru: "Фоновая операция backend завершилась аварийно",
    en: "The backend background operation failed",
  },
  bootstrap_failed: { ru: "Не удалось загрузить данные OMP", en: "Failed to load OMP data" },
  workspace_add_failed: { ru: "Не удалось добавить проект", en: "Failed to add the project" },
  settings_save_failed: { ru: "Не удалось сохранить настройки", en: "Failed to save settings" },
  resource_health_failed: {
    ru: "Не удалось проверить системные ресурсы",
    en: "Failed to check system resources",
  },
  session_active_rename: {
    ru: "Сначала остановите активную сессию OMP",
    en: "Stop the active OMP session before renaming it",
  },
  session_rename_failed: {
    ru: "Не удалось переименовать сессию",
    en: "Failed to rename the session",
  },
  session_delete_failed: { ru: "Не удалось удалить сессию", en: "Failed to delete the session" },
  session_import_failed: {
    ru: "Не удалось импортировать сессию",
    en: "Failed to import the session",
  },
  codex_sessions_load_failed: {
    ru: "Не удалось загрузить сессии Codex",
    en: "Failed to load Codex sessions",
  },
  transcript_read_failed: {
    ru: "Не удалось прочитать транскрипт",
    en: "Failed to read the transcript",
  },
  omp_config_load_failed: {
    ru: "Не удалось загрузить настройки OMP",
    en: "Failed to load OMP settings",
  },
  omp_config_save_failed: {
    ru: "Не удалось сохранить настройки OMP",
    en: "Failed to save OMP settings",
  },
  omp_update_check_failed: {
    ru: "Не удалось проверить обновление OMP",
    en: "Failed to check for OMP updates",
  },
  omp_timeout: {
    ru: "OMP не ответил вовремя и был остановлен",
    en: "OMP timed out and was stopped",
  },
  omp_output_limit: {
    ru: "OMP вернул слишком большой объём данных",
    en: "OMP returned too much data",
  },
  omp_spawn_failed: { ru: "Не удалось запустить OMP", en: "Failed to start OMP" },
  omp_io_failed: { ru: "Ошибка обмена данными с OMP", en: "Failed to communicate with OMP" },
  omp_invalid_json: { ru: "OMP вернул некорректные данные", en: "OMP returned invalid data" },
  omp_command_failed: { ru: "Команда OMP завершилась с ошибкой", en: "The OMP command failed" },
}

export function errorMessage(error: unknown, language: Lang = "ru"): string {
  const parsed = parseBackendError(error)
  if (parsed.code && BACKEND_ERROR_TEXT[parsed.code]) {
    return BACKEND_ERROR_TEXT[parsed.code][language]
  }
  return (
    parsed.message || parsed.details || (language === "en" ? "Unknown error" : "Неизвестная ошибка")
  )
}

function parseBackendError(error: unknown): BackendError {
  if (error && typeof error === "object" && !(error instanceof Error)) {
    const candidate = error as BackendError
    if (candidate.code || candidate.message || candidate.details) return candidate
  }
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error)
  if (raw?.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw) as BackendError
    } catch {
      // Fall through to the plain message.
    }
  }
  return { message: raw || undefined }
}

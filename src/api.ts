import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core"
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
  SettingsUnavailableDetails,
  TerminalAttachment,
  TerminalStarted,
  TerminalRuntime,
  SwitchInputRecoveryMetadata,
} from "./types"
import type { Lang } from "./i18n"

type SettingsUnavailableListener = (details: SettingsUnavailableDetails) => void

const settingsUnavailableListeners = new Set<SettingsUnavailableListener>()

async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options)
  } catch (error) {
    const details = settingsUnavailableDetails(error)
    if (details) {
      for (const listener of settingsUnavailableListeners) listener(details)
    }
    throw error
  }
}

export function subscribeSettingsUnavailable(listener: SettingsUnavailableListener): () => void {
  settingsUnavailableListeners.add(listener)
  return () => {
    settingsUnavailableListeners.delete(listener)
  }
}

export function bootstrap(): Promise<BootstrapPayload> {
  return invoke("bootstrap")
}

export function startWithDefaults(): Promise<BootstrapPayload> {
  return invoke("start_with_defaults")
}

export function addWorkspace(path: string): Promise<BootstrapPayload> {
  return invoke("add_workspace", { path })
}

export function renameWorkspace(path: string, name: string): Promise<BootstrapPayload> {
  return invoke("rename_workspace", { path, name })
}

export function removeWorkspace(path: string): Promise<BootstrapPayload> {
  return invoke("remove_workspace", { path })
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
  forceSessionLease = false,
): Promise<TerminalStarted> {
  return invoke("start_terminal", {
    request: { cwd, resumePath, cols, rows, args, forceSessionLease },
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

export function sendSwitchInputRecovery(
  terminalId: string,
  generation: number,
  token: string,
): Promise<void> {
  return invoke("send_switch_input_recovery", {
    request: { terminalId, generation, token },
  })
}

export function discardSwitchInputRecovery(
  terminalId: string,
  generation: number,
  token: string,
): Promise<void> {
  return invoke("discard_switch_input_recovery", {
    request: { terminalId, generation, token },
  })
}

export function setTerminalPrimaryProviderPin(
  terminalId: string,
  pinned: boolean,
): Promise<TerminalStarted> {
  return invoke("set_terminal_primary_provider_pin", {
    request: { terminalId, pinned },
  })
}

export function attachTerminal(
  terminalId: string,
  attachmentId: string,
  generation: number | null,
  afterSeq: number | null,
): Promise<TerminalAttachment> {
  return invoke("attach_terminal", {
    request: { terminalId, attachmentId, generation, afterSeq },
  })
}

export function detachTerminal(terminalId: string, attachmentId: string): Promise<void> {
  return invoke("detach_terminal", { request: { terminalId, attachmentId } })
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

export function deleteSession(path: string, forceSessionLease = false): Promise<BootstrapPayload> {
  return invoke("delete_session", { path, forceSessionLease })
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
  settingsPath?: string
  backupPath?: string | null
  failureStage?: string
  recovery?: SwitchInputRecoveryMetadata | null
}

export interface SessionLeaseConflictDetails {
  metadataState: "valid" | "corrupt" | "missing"
  ownerPid: number | null
  ownerStartedAt: string | null
  acquiredAt: string | null
  sessionPath: string
}

const BACKEND_ERROR_TEXT: Record<string, Record<Lang, string>> = {
  backend_join_failed: {
    ru: "Фоновая операция backend завершилась аварийно",
    en: "The backend background operation failed",
  },
  bootstrap_failed: { ru: "Не удалось загрузить данные OMP", en: "Failed to load OMP data" },
  settings_unavailable: {
    ru: "Настройки OMP Desktop недоступны",
    en: "OMP Desktop settings are unavailable",
  },
  workspace_add_failed: { ru: "Не удалось добавить проект", en: "Failed to add the project" },
  workspace_rename_failed: {
    ru: "Не удалось переименовать проект",
    en: "Failed to rename the project",
  },
  workspace_remove_failed: {
    ru: "Не удалось удалить проект из списка",
    en: "Failed to remove the project from the list",
  },
  settings_save_failed: { ru: "Не удалось сохранить настройки", en: "Failed to save settings" },
  resource_health_failed: {
    ru: "Не удалось проверить системные ресурсы",
    en: "Failed to check system resources",
  },
  session_active_rename: {
    ru: "Сначала остановите активную сессию OMP",
    en: "Stop the active OMP session before renaming it",
  },
  session_active_delete: {
    ru: "Сначала остановите активную сессию OMP",
    en: "Stop the active OMP session before deleting it",
  },
  session_lease_active: {
    ru: "Эта сессия уже открыта другим процессом OMP Desktop",
    en: "This session is already open in another OMP Desktop process",
  },
  session_lease_stale: {
    ru: "После аварийного завершения осталась запись владельца сессии",
    en: "A stale session owner record remains after an interrupted run",
  },
  session_lease_failed: {
    ru: "Не удалось безопасно получить владение сессией",
    en: "Failed to acquire session ownership safely",
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
  terminal_switch_failed: { ru: "Не удалось сменить модель", en: "Failed to switch models" },
  terminal_switch_busy: { ru: "Смена модели уже выполняется", en: "A model switch is in progress" },
  terminal_switch_input_recovery: {
    ru: "Смена модели не завершилась; ввод сохранён",
    en: "The model switch failed; input was preserved",
  },
  terminal_switch_recovery_pending: {
    ru: "Сначала обработайте сохранённый ввод",
    en: "Resolve the preserved input first",
  },
  terminal_switch_recovery_send_failed: {
    ru: "Не удалось безопасно отправить сохранённый ввод",
    en: "Failed to send the preserved input safely",
  },
  terminal_switch_recovery_stale: {
    ru: "Состояние сохранённого ввода уже изменилось",
    en: "The preserved input state has changed",
  },
  terminal_switch_recovery_busy: {
    ru: "Сохранённый ввод уже отправляется",
    en: "The preserved input is already being sent",
  },
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

export function backendErrorCode(error: unknown): string | null {
  return parseBackendError(error).code ?? null
}

export function sessionLeaseConflictDetails(error: unknown): SessionLeaseConflictDetails | null {
  const parsed = parseBackendError(error)
  if (parsed.code !== "session_lease_active" && parsed.code !== "session_lease_stale") return null
  if (!parsed.details) return null
  try {
    const details = JSON.parse(parsed.details) as Partial<SessionLeaseConflictDetails>
    if (
      !["valid", "corrupt", "missing"].includes(details.metadataState ?? "") ||
      typeof details.sessionPath !== "string" ||
      (details.ownerPid !== null &&
        details.ownerPid !== undefined &&
        !Number.isSafeInteger(details.ownerPid)) ||
      (details.ownerStartedAt !== null &&
        details.ownerStartedAt !== undefined &&
        typeof details.ownerStartedAt !== "string") ||
      (details.acquiredAt !== null &&
        details.acquiredAt !== undefined &&
        typeof details.acquiredAt !== "string")
    ) {
      return null
    }
    return {
      metadataState: details.metadataState as SessionLeaseConflictDetails["metadataState"],
      ownerPid: details.ownerPid ?? null,
      ownerStartedAt: details.ownerStartedAt ?? null,
      acquiredAt: details.acquiredAt ?? null,
      sessionPath: details.sessionPath,
    }
  } catch {
    return null
  }
}

export function settingsUnavailableDetails(error: unknown): SettingsUnavailableDetails | null {
  const parsed = parseBackendError(error)
  if (parsed.code !== "settings_unavailable") return null
  return {
    code: "settings_unavailable",
    message: parsed.message || "Настройки OMP Desktop недоступны",
    details: parsed.details || null,
    settingsPath: parsed.settingsPath?.trim() || "settings.json",
    backupPath: parsed.backupPath?.trim() || null,
    failureStage: parsed.failureStage?.trim() || "unknown",
  }
}

export function switchInputRecoveryDetails(error: unknown): SwitchInputRecoveryMetadata | null {
  const recovery = parseBackendError(error).recovery
  if (!recovery || typeof recovery !== "object") return null
  if (
    typeof recovery.terminalId !== "string" ||
    !["pending", "sending", "failedSend"].includes(recovery.state) ||
    !Number.isSafeInteger(recovery.generation) ||
    recovery.generation < 0 ||
    !Number.isSafeInteger(recovery.byteCount) ||
    recovery.byteCount < 0 ||
    typeof recovery.token !== "string" ||
    recovery.token.length === 0
  ) {
    return null
  }
  return {
    terminalId: recovery.terminalId,
    state: recovery.state,
    generation: recovery.generation,
    byteCount: recovery.byteCount,
    token: recovery.token,
  }
}

const MAX_BACKEND_ERROR_TEXT = 8 * 1024

function normalizeBackendError(value: unknown): BackendError | null {
  if (!value || typeof value !== "object" || value instanceof Error) return null
  const candidate = value as Record<string, unknown>
  const normalized: BackendError = {}
  if (typeof candidate.code === "string") normalized.code = candidate.code
  if (typeof candidate.message === "string") normalized.message = candidate.message
  if (typeof candidate.details === "string") normalized.details = candidate.details
  if (typeof candidate.settingsPath === "string") normalized.settingsPath = candidate.settingsPath
  if (candidate.backupPath === null || typeof candidate.backupPath === "string") {
    normalized.backupPath = candidate.backupPath
  }
  if (typeof candidate.failureStage === "string") normalized.failureStage = candidate.failureStage
  if (candidate.recovery && typeof candidate.recovery === "object") {
    normalized.recovery = candidate.recovery as SwitchInputRecoveryMetadata
  }
  return normalized.code || normalized.message || normalized.details ? normalized : null
}

function boundedBackendErrorText(value: string): string {
  return value.length <= MAX_BACKEND_ERROR_TEXT
    ? value
    : `${value.slice(0, MAX_BACKEND_ERROR_TEXT)}…`
}

function parseBackendError(error: unknown): BackendError {
  const structured = normalizeBackendError(error)
  if (structured) return structured

  let raw: string
  if (error instanceof Error) raw = error.message
  else if (typeof error === "string") raw = error
  else {
    try {
      raw = JSON.stringify(error) ?? ""
    } catch {
      raw = String(error)
    }
  }
  raw = boundedBackendErrorText(raw)
  const coded = /^\[([a-z_]+)]\s*([\s\S]*)$/.exec(raw)
  if (coded) {
    return { code: coded[1], details: coded[2] || undefined }
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = normalizeBackendError(JSON.parse(raw))
      if (parsed) return parsed
    } catch {
      // Fall through to the plain message.
    }
  }
  return { message: raw || undefined }
}

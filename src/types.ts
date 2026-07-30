export interface SettingsWarning {
  code: string
  message: string
  details: string | null
}

export interface AppSettings {
  ompExecutable: string | null
  sessionRoot: string | null
  recentWorkspaces: string[]
  sessionTitlePins: Record<string, string>
  language: "ru" | "en"
  appFontFamily: string
  terminalFontFamily: string
  terminalFontSize: number
  providerEnvKeys: string[]
  secretStorageWarning: string | null
  settingsWarning: SettingsWarning | null
}

export interface RuntimeInfo {
  platform: string
  arch: string
  language: string
  ompAvailable: boolean
  ompExecutable: string
  ompVersion: string | null
  sessionRoot: string
}

export interface SessionSummary {
  id: string
  title: string
  pinnedTitle: string | null
  cwd: string
  filePath: string
  createdAt: string
  updatedAt: number
  model: string | null
  thinkingLevel: string | null
  configuredThinkingLevel: string | null
  source: string
  hasMessages: boolean
}

export interface TranscriptEntry {
  id: string
  timestamp: string
  role: string
  text: string
  dialogueText: string | null
  category: "dialogue" | "service"
  kind?: string
  model?: string
}

export interface SessionTranscript {
  session: SessionSummary
  entries: TranscriptEntry[]
  updatedAt: number
}

export interface WorkspaceSummary {
  path: string
  name: string
  sessionCount: number
  lastActive: number
  pinned: boolean
}

export interface BootstrapPayload {
  settings: AppSettings
  runtime: RuntimeInfo
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
}

export interface SettingsUpdate {
  ompExecutable?: string | null
  appFontFamily?: string | null

  terminalFontFamily?: string | null
  terminalFontSize?: number | null
  sessionRoot?: string | null
  language?: "ru" | "en" | null
  providerEnv?: Record<string, string> | null
}

export interface OmpModelInfo {
  provider: string
  id: string
  selector: string
  name: string
  available: boolean
  status: string
  detail: string | null
  thinking: string[]
}

export interface OmpRoleInfo {
  role: string
  selector: string
  model: OmpModelInfo | null
  available: boolean
  status: string
  detail: string | null
}

export interface OmpCredentialInfo {
  provider: string
  keyName: string | null
  source: "desktop" | "environment" | "command" | "models" | "omp"
  status: "ready" | "configured" | "ok" | "limited" | "exhausted" | "missing"
  available: boolean
  modelCount: number
}

export interface OmpConfigWarning {
  source: "models" | "usage" | string
  code: string
  message: string
}

export interface OmpConfigSnapshot {
  roles: OmpRoleInfo[]
  models: OmpModelInfo[]
  advisorEnabled: boolean
  autoResume: boolean
  defaultThinkingLevel: string | null
  modelFallbackEnabled: boolean
  fallbackChains: Record<string, string[]>
  providerEnvKeys: string[]
  credentials: OmpCredentialInfo[]
  warnings: OmpConfigWarning[]
  raw: Record<string, unknown>
}

export interface OmpConfigSaveRequest {
  roles: Record<string, string>
  advisorEnabled?: boolean | null
  autoResume?: boolean | null
  defaultThinkingLevel?: string | null
  modelFallbackEnabled?: boolean | null
  fallbackChains?: Record<string, string[]> | null
  providerEnv?: Record<string, string> | null
}

export interface OmpUpdateInfo {
  hasUpdate: boolean
  currentVersion: string | null
  latestVersion: string | null
  message: string
}

export interface CodexSessionSummary {
  id: string
  title: string
  cwd: string
  filePath: string
  createdAt: string
  updatedAt: number
  model: string | null
  preview: string
}

export interface TerminalStarted {
  terminalId: string
  processId: number | null
  cwd: string
}

export interface TerminalRuntime {
  terminalId: string
  model: string
  modelRole: string | null
  thinkingLevel: string | null
  configuredThinkingLevel: string | null
}

export interface TerminalAttachment {
  data: string
  exited: boolean
  exitCode: number | null
  success: boolean
  error: string | null
}

export interface PtySessionEvent {
  terminalId: string
  session: SessionSummary
}

export interface PtyRuntimeEvent {
  terminalId: string
  model: string | null
  modelRole: string | null
  thinkingLevel: string | null
  configuredThinkingLevel: string | null
  activity: TerminalActivity | null
  errorMessage: string | null
}

export interface PtyUpdateEvent {
  terminalId: string
}

export interface PtyOutputEvent {
  terminalId: string
  data: string
}

export interface PtyExitEvent {
  terminalId: string
  exitCode: number | null
  success: boolean
  error: string | null
}

export type TerminalStatus = "running" | "exited"
export type TerminalActivity = "idle" | "thinking" | "error"

export interface TerminalTab {
  id: string
  label: string
  pinnedTitle: string | null
  cwd: string
  processId: number | null
  sessionId: string | null
  sessionPath: string | null
  status: TerminalStatus
  activity: TerminalActivity
  exitCode: number | null
  success: boolean | null
  kind: "agent" | "utility"
  switching: boolean
  currentModel?: string
  currentModelRole?: string | null
  currentThinking?: string | null
  currentThinkingConfigured?: string | null
}

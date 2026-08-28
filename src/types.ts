export interface SettingsWarning {
  code: string
  message: string
  details: string | null
}

export type RailMode = "expanded" | "collapsed" | "autoHide"

export interface AppSettings {
  ompExecutable: string | null
  sessionRoot: string | null
  recentWorkspaces: string[]
  workspaceNames: Record<string, string>
  hiddenWorkspaces: string[]
  sessionTitlePins: Record<string, string>
  primaryProviderPins: string[]
  railMode: RailMode
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

export type ResourceSeverity = "ok" | "warning" | "critical"

export interface ResourceMemorySnapshot {
  availableBytes: number
  totalBytes: number
  usedSwapBytes: number
  totalSwapBytes: number
  availableSeverity: ResourceSeverity
  swapSeverity: ResourceSeverity
  severity: ResourceSeverity
}

export interface ResourceVolumeSnapshot {
  mountPath: string
  availableBytes: number
  totalBytes: number
  purposes: string[]
  severity: ResourceSeverity
}

export interface ResourceProcessSnapshot {
  terminalId: string | null
  processId: number
  residentBytes: number
  source: "desktop" | "omp"
}

export interface ResourceHealthSnapshot {
  sampledAt: number
  severity: ResourceSeverity
  memory: ResourceMemorySnapshot
  volumes: ResourceVolumeSnapshot[]
  processes: ResourceProcessSnapshot[]
}

export interface SessionSummary {
  id: string
  title: string
  pinnedTitle: string | null
  cwd: string
  projectKey: string
  filePath: string
  parentSessionPath: string | null
  createdAt: string
  updatedAt: number
  model: string | null
  thinkingLevel: string | null
  configuredThinkingLevel: string | null
  source: string
  hasMessages: boolean
  primaryProviderPinned: boolean
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
  truncated: boolean
}

export interface WorkspaceSummary {
  key: string
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

export type ImportMode = "skip" | "update" | "copy"

export interface ImportSessionRequest {
  path: string
  targetCwd: string
  mode: ImportMode
}

export type ImportItemStatus = "imported" | "updated" | "copied" | "skipped" | "failed"

export interface ImportItemResult {
  sourcePath: string
  destinationPath: string | null
  status: ImportItemStatus
  message: string | null
}

export interface ImportBatchPayload {
  bootstrap: BootstrapPayload
  items: ImportItemResult[]
}

export interface SettingsUpdate {
  ompExecutable?: string | null
  appFontFamily?: string | null

  terminalFontFamily?: string | null
  terminalFontSize?: number | null
  sessionRoot?: string | null
  language?: "ru" | "en" | null
  railMode?: RailMode | null
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
  proxyProviders: string[]
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
  proxyProviders?: string[] | null
  providerEnv?: Record<string, string> | null
}

export interface SettingsSaveRequest {
  update: SettingsUpdate
  ompConfig: OmpConfigSaveRequest | null
}

export interface SettingsSavePayload {
  bootstrap: BootstrapPayload
  ompConfig: OmpConfigSnapshot | null
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

export interface PtySessionTitleEvent {
  terminalId: string
  title: string
}

export type PtyRuntimeEventKind =
  | "activity"
  | "runtimeError"
  | "modelChange"
  | "retryFallbackApplied"
  | "thinkingLevelChange"
  | "modelError"

export interface PtyRuntimeEvent {
  terminalId: string
  kind: PtyRuntimeEventKind
  model: string | null
  modelRole: string | null
  thinkingLevel: string | null
  configuredThinkingLevel: string | null
  activity: TerminalActivity | null
  errorMessage: string | null
  fallbackFrom: string | null
  fallbackTo: string | null
  fallbackRole: string | null
  resolvedModelIsFallback: boolean | null
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
  primaryProviderPinned: boolean
  primaryProviderPinPending: boolean
}

export interface AppSettings {
  ompExecutable: string | null;
  sessionRoot: string | null;
  recentWorkspaces: string[];
  language: "ru" | "en";
  providerEnv: Record<string, string>;
}

export interface RuntimeInfo {
  platform: string;
  arch: string;
  language: string;
  ompAvailable: boolean;
  ompExecutable: string;
  ompVersion: string | null;
  sessionRoot: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  filePath: string;
  createdAt: string;
  updatedAt: number;
  model: string | null;
  thinkingLevel: string | null;
  configuredThinkingLevel: string | null;
  source: string;
  hasMessages: boolean;
}

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  role: string;
  text: string;
  dialogueText: string | null;
  category: "dialogue" | "service";
  kind?: string;
  model?: string;
}

export interface SessionTranscript {
  session: SessionSummary;
  entries: TranscriptEntry[];
  updatedAt: number;
}

export interface WorkspaceSummary {
  path: string;
  name: string;
  sessionCount: number;
  lastActive: number;
  pinned: boolean;
}

export interface BootstrapPayload {
  settings: AppSettings;
  runtime: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
}

export interface SettingsUpdate {
  ompExecutable: string | null;
  sessionRoot: string | null;
  language: "ru" | "en" | null;
  providerEnv?: Record<string, string> | null;
}

export interface OmpModelInfo {
  provider: string;
  id: string;
  selector: string;
  name: string;
  available: boolean;
  status: string;
  detail: string | null;
  thinking: string[];
}

export interface OmpRoleInfo {
  role: string;
  selector: string;
  model: OmpModelInfo | null;
  available: boolean;
  status: string;
  detail: string | null;
}

export interface OmpConfigSnapshot {
  roles: OmpRoleInfo[];
  models: OmpModelInfo[];
  advisorEnabled: boolean;
  autoResume: boolean;
  defaultThinkingLevel: string | null;
  providerEnvKeys: string[];
  raw: Record<string, unknown>;
}

export interface OmpConfigSaveRequest {
  roles: Record<string, string>;
  advisorEnabled?: boolean | null;
  autoResume?: boolean | null;
  defaultThinkingLevel?: string | null;
  providerEnv?: Record<string, string> | null;
}

export interface OmpUpdateInfo {
  hasUpdate: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  message: string;
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  cwd: string;
  filePath: string;
  createdAt: string;
  updatedAt: number;
  model: string | null;
  preview: string;
}

export interface TerminalStarted {
  terminalId: string;
  processId: number | null;
  cwd: string;
}

export interface TerminalRuntime {
  terminalId: string;
  model: string;
  modelRole: string | null;
  thinkingLevel: string | null;
  configuredThinkingLevel: string | null;
}

export interface TerminalAttachment {
  data: string;
  exited: boolean;
  exitCode: number | null;
  success: boolean;
  error: string | null;
}

export interface PtySessionEvent {
  terminalId: string;
  session: SessionSummary;
}

export interface PtyRuntimeEvent {
  terminalId: string;
  model: string | null;
  modelRole: string | null;
  thinkingLevel: string | null;
  configuredThinkingLevel: string | null;
  activity: TerminalActivity | null;
}

export interface PtyOutputEvent {
  terminalId: string;
  data: string;
}

export interface PtyExitEvent {
  terminalId: string;
  exitCode: number | null;
  success: boolean;
  error: string | null;
}

export type TerminalStatus = "running" | "exited";
export type TerminalActivity = "idle" | "thinking";

export interface TerminalTab {
  id: string;
  label: string;
  cwd: string;
  processId: number | null;
  sessionId: string | null;
  sessionPath: string | null;
  status: TerminalStatus;
  activity: TerminalActivity;
  exitCode: number | null;
  success: boolean | null;
  kind: "agent" | "utility";
  switching: boolean;
  currentModel?: string;
  currentModelRole?: string | null;
  currentThinking?: string | null;
  currentThinkingConfigured?: string | null;
}

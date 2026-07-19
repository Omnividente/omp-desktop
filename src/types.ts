export interface AppSettings {
  ompExecutable: string | null;
  sessionRoot: string | null;
  recentWorkspaces: string[];
}

export interface RuntimeInfo {
  platform: string;
  arch: string;
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
}

export interface TerminalStarted {
  terminalId: string;
  processId: number | null;
  cwd: string;
}

export interface TerminalAttachment {
  data: string;
  exited: boolean;
  exitCode: number | null;
  success: boolean;
  error: string | null;
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

export interface TerminalTab {
  id: string;
  label: string;
  cwd: string;
  processId: number | null;
  sessionId: string | null;
  status: TerminalStatus;
  exitCode: number | null;
  success: boolean | null;
}

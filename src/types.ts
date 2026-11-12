export type RunnerType = "opencode" | "fake";
export type QueryProfile = "answer" | "implementation" | "transfer";

export interface ProjectConfig {
  name: string;
  aliases: string[];
  path: string;
  runner: {
    type: RunnerType;
    executable?: string;
    model?: string;
  };
  instructionPaths: string[];
}

export interface RegistryConfig {
  version: 1;
  defaults: {
    timeoutMs: number;
    idleTimeoutMs: number;
    maxReportBytes: number;
  };
  projects: ProjectConfig[];
}

export interface ReportFile {
  path: string;
  purpose: string;
}

export interface ReportSetting {
  name: string;
  purpose: string;
}

export interface ResearchReport {
  summary: string;
  files: ReportFile[];
  flow: string[];
  configuration: ReportSetting[];
  tests: string[];
  transferable_practices: string[];
  project_specific_details: string[];
  risks: string[];
  unanswered_questions: string[];
}

export interface RunnerRequest {
  project: ProjectConfig;
  projectPath: string;
  prompt: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxOutputBytes: number;
  profile: QueryProfile;
  maxSteps?: number;
  sessionId?: string;
  onSessionId?: (sessionId: string) => void;
  onProgress?: (event: RunnerProgressEvent) => void;
}

export interface RunnerProgressEvent {
  kind: "start" | "activity" | "usage" | "heartbeat";
  message: string;
  eventType: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Runner {
  readonly type: RunnerType;
  run(request: RunnerRequest): Promise<string>;
}

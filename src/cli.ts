#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  defaultConfigPath,
  loadRegistry,
  resolveAllowedProject,
} from "./config.js";
import { RelayError } from "./errors.js";
import { installOpenCodeSkill } from "./opencode-skill.js";
import {
  buildContinuationPrompt,
  buildReportRepairPrompt,
  buildResearchPrompt,
} from "./prompt.js";
import { parseReport } from "./report.js";
import { runnerFor } from "./runner.js";
import {
  acquireProjectLock,
  appendAuditEvent,
  defaultStatePath,
  latestSuccessfulRun,
  newRunRecord,
  readRunRecord,
  releaseProjectLock,
  saveReport,
  writeRunRecord,
} from "./storage.js";
import type { RunRecord } from "./storage.js";
import type { QueryProfile, ResearchReport, RunnerType } from "./types.js";

interface AskOptions {
  project: string;
  question: string;
  configPath: string;
  follow: "none" | "compact" | "details";
  profile: QueryProfile;
}

interface InstallOptions {
  force: boolean;
}

interface ResumeOptions {
  runId: string;
  question: string;
  configPath: string;
  follow: AskOptions["follow"];
  profile?: QueryProfile;
}

function usage(): string {
  return `Usage:
  project-agent-relay ask --project <name> --question <text> [--profile answer|implementation|transfer] [--config <file>] [--follow|--follow-details]
  project-agent-relay resume --run <id> --question <text> [--profile answer|implementation|transfer] [--config <file>] [--follow|--follow-details]
  project-agent-relay status --run <id>
  project-agent-relay latest --project <name> [--config <file>]
  project-agent-relay install-opencode-skill [--force]

The default registry is ${defaultConfigPath()}`;
}

function parseInstallArguments(args: string[]): InstallOptions {
  if (
    args.length > 2 ||
    args.slice(1).some((argument) => argument !== "--force")
  ) {
    throw new RelayError("USAGE", usage(), 2);
  }
  return { force: args.includes("--force") };
}

export function parseArguments(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): AskOptions {
  if (args[0] !== "ask") throw new RelayError("USAGE", usage(), 2);
  const values = new Map<string, string>();
  let follow: AskOptions["follow"] = "none";
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--follow" || key === "--follow-details") {
      if (follow !== "none")
        throw new RelayError(
          "USAGE",
          "only one follow mode can be selected",
          2,
        );
      follow = key === "--follow" ? "compact" : "details";
      continue;
    }
    const value = args[index + 1];
    if (
      !key ||
      !["--project", "--question", "--profile", "--config"].includes(key) ||
      !value
    ) {
      throw new RelayError("USAGE", usage(), 2);
    }
    if (values.has(key))
      throw new RelayError("USAGE", `duplicate option: ${key}`, 2);
    values.set(key, value);
    index += 1;
  }
  const project = values.get("--project");
  const question = values.get("--question");
  const profile = values.get("--profile") || "implementation";
  if (!project || !question?.trim()) throw new RelayError("USAGE", usage(), 2);
  if (
    !(["answer", "implementation", "transfer"] as string[]).includes(profile)
  ) {
    throw new RelayError("USAGE", `invalid profile: ${profile}`, 2);
  }
  if (Buffer.byteLength(question, "utf8") > 10_000 || question.includes("\0")) {
    throw new RelayError(
      "USAGE",
      "question must be at most 10,000 bytes and contain no null bytes",
      2,
    );
  }
  return {
    project,
    question: question.trim(),
    follow,
    profile: profile as QueryProfile,
    configPath: path.resolve(
      values.get("--config") ||
        environment.PROJECT_AGENT_RELAY_CONFIG ||
        defaultConfigPath(environment),
    ),
  };
}

export function parseResumeArguments(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ResumeOptions {
  const values = new Map<string, string>();
  let follow: AskOptions["follow"] = "none";
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--follow" || key === "--follow-details") {
      if (follow !== "none")
        throw new RelayError(
          "USAGE",
          "only one follow mode can be selected",
          2,
        );
      follow = key === "--follow" ? "compact" : "details";
      continue;
    }
    const value = args[index + 1];
    if (
      !key ||
      !["--run", "--question", "--profile", "--config"].includes(key) ||
      !value
    ) {
      throw new RelayError("USAGE", usage(), 2);
    }
    if (values.has(key))
      throw new RelayError("USAGE", `duplicate option: ${key}`, 2);
    values.set(key, value);
    index += 1;
  }
  const runId = values.get("--run");
  const question = values.get("--question");
  const profile = values.get("--profile");
  if (!runId || !question?.trim()) throw new RelayError("USAGE", usage(), 2);
  if (
    profile !== undefined &&
    !(["answer", "implementation", "transfer"] as string[]).includes(profile)
  ) {
    throw new RelayError("USAGE", `invalid profile: ${profile}`, 2);
  }
  if (Buffer.byteLength(question, "utf8") > 10_000 || question.includes("\0")) {
    throw new RelayError(
      "USAGE",
      "question must be at most 10,000 bytes and contain no null bytes",
      2,
    );
  }
  return {
    runId,
    question: question.trim(),
    follow,
    ...(profile ? { profile: profile as QueryProfile } : {}),
    configPath: path.resolve(
      values.get("--config") ||
        environment.PROJECT_AGENT_RELAY_CONFIG ||
        defaultConfigPath(environment),
    ),
  };
}

function parseStatusRunId(args: string[]): string {
  if (args.length !== 3 || args[1] !== "--run" || !args[2]) {
    throw new RelayError("USAGE", usage(), 2);
  }
  return args[2];
}

function parseLatestOptions(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { project: string; configPath: string } {
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--project", "--config"].includes(key) || !value) {
      throw new RelayError("USAGE", usage(), 2);
    }
    values.set(key, value);
  }
  const project = values.get("--project");
  if (!project) throw new RelayError("USAGE", usage(), 2);
  return {
    project,
    configPath: path.resolve(
      values.get("--config") ||
        environment.PROJECT_AGENT_RELAY_CONFIG ||
        defaultConfigPath(environment),
    ),
  };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let runRecord: RunRecord | undefined;
  let runnerType: RunnerType | undefined;
  let lockHeld = false;
  const started = Date.now();
  const statePath = defaultStatePath();
  try {
    if (args[0] === "install-opencode-skill") {
      const installOptions = parseInstallArguments(args);
      const result = await installOpenCodeSkill(installOptions);
      process.stdout.write(`Installed OpenCode skill at ${result.skillPath}\n`);
      process.stdout.write(
        `Allowed relay lifecycle commands in ${result.configPath}\n`,
      );
      return 0;
    }
    if (args[0] === "status") {
      const record = await readRunRecord(statePath, parseStatusRunId(args));
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      return 0;
    }
    if (args[0] === "latest") {
      const latestOptions = parseLatestOptions(args);
      const registry = await loadRegistry(latestOptions.configPath);
      const { project } = await resolveAllowedProject(
        registry,
        latestOptions.project,
      );
      const record = await latestSuccessfulRun(statePath, project.name);
      if (!record?.reportPath) {
        throw new RelayError(
          "REPORT",
          `no saved report for project "${project.name}"`,
          5,
        );
      }
      const reportRoot = path.resolve(statePath, "reports");
      const reportPath = path.resolve(record.reportPath);
      const relative = path.relative(reportRoot, reportPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new RelayError(
          "INTERNAL",
          "saved report path is outside relay state",
          1,
        );
      }
      process.stdout.write(await readFile(reportPath, "utf8"));
      process.stderr.write(`Run ID: ${record.id}\n`);
      return 0;
    }

    let question: string;
    let configPath: string;
    let followMode: AskOptions["follow"];
    let requestedProject: string;
    let profile: QueryProfile;
    let sessionId: string | undefined;
    let continuation = false;
    if (args[0] === "resume") {
      const resume = parseResumeArguments(args);
      const existing = await readRunRecord(statePath, resume.runId);
      if (!existing.sessionId) {
        throw new RelayError(
          "RUNNER",
          `run ${existing.id} has no OpenCode session to resume`,
          4,
        );
      }
      profile = resume.profile || existing.profile;
      runRecord = {
        ...existing,
        profile,
        status: "starting",
        updatedAt: new Date().toISOString(),
        attempts: existing.attempts + 1,
        pid: process.pid,
      };
      question = resume.question;
      configPath = resume.configPath;
      followMode = resume.follow;
      requestedProject = existing.project;
      sessionId = existing.sessionId;
      continuation = true;
    } else {
      const ask = parseArguments(args);
      question = ask.question;
      configPath = ask.configPath;
      followMode = ask.follow;
      requestedProject = ask.project;
      profile = ask.profile;
    }

    const registry = await loadRegistry(configPath);
    const { project, realPath } = await resolveAllowedProject(
      registry,
      requestedProject,
    );
    runnerType = project.runner.type;
    if (
      runRecord &&
      (runRecord.project !== project.name || runRecord.runner !== runnerType)
    ) {
      throw new RelayError(
        "CONFIG",
        `run ${runRecord.id} no longer matches its registered project`,
        2,
      );
    }
    runRecord ||= newRunRecord(project.name, runnerType, profile);
    await acquireProjectLock(statePath, project.name, runRecord.id);
    lockHeld = true;
    await writeRunRecord(statePath, runRecord);
    process.stderr.write(
      `Run ID: ${runRecord.id}${continuation ? " (resumed)" : ""}\n`,
    );

    const runner = runnerFor(runnerType);
    let sessionWrite = Promise.resolve();
    const progressStarted = Date.now();
    let progressStep = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastActivity = progressStarted;
    const elapsed = () => {
      const seconds = Math.floor((Date.now() - progressStarted) / 1_000);
      return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    };
    const tokenCount = (value: number) =>
      value < 1_000
        ? String(value)
        : `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    const output = await runner.run({
      project,
      projectPath: realPath,
      prompt: continuation
        ? buildContinuationPrompt(project, question, profile)
        : buildResearchPrompt(project, question, profile),
      timeoutMs: registry.defaults.timeoutMs,
      idleTimeoutMs: registry.defaults.idleTimeoutMs,
      maxOutputBytes: Math.min(registry.defaults.maxReportBytes * 4, 4_194_304),
      profile,
      ...(sessionId ? { sessionId } : {}),
      onSessionId: (capturedSessionId) => {
        if (!runRecord) return;
        runRecord = {
          ...runRecord,
          sessionId: capturedSessionId,
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        const snapshot = runRecord;
        sessionWrite = writeRunRecord(statePath, snapshot).catch(
          () => undefined,
        );
      },
      ...(followMode !== "none"
        ? {
            onProgress: (event) => {
              if (event.kind === "start") {
                process.stderr.write(`[${elapsed()}] ${event.message}\n`);
                return;
              }
              if (event.kind === "heartbeat") {
                if (followMode === "details") {
                  process.stderr.write(`[${elapsed()}] ${event.message}\n`);
                  return;
                }
                const idleSeconds = Math.floor(
                  (Date.now() - lastActivity) / 1_000,
                );
                process.stderr.write(
                  `[${elapsed()}] Working · step ${progressStep} · last activity ${idleSeconds}s ago · tokens in ${tokenCount(totalInputTokens)}, out ${tokenCount(totalOutputTokens)}\n`,
                );
                return;
              }
              lastActivity = Date.now();
              if (["step-start", "step_start"].includes(event.eventType))
                progressStep += 1;
              totalInputTokens += event.inputTokens || 0;
              totalOutputTokens += event.outputTokens || 0;
              if (followMode === "details") {
                process.stderr.write(`[${elapsed()}] ${event.message}\n`);
              }
            },
          }
        : {}),
    });
    await sessionWrite;
    let report: ResearchReport;
    try {
      report = parseReport(output, registry.defaults.maxReportBytes, profile);
    } catch (error) {
      if (
        !(error instanceof RelayError) ||
        error.code !== "REPORT" ||
        !runRecord.sessionId
      ) {
        throw error;
      }
      if (followMode !== "none") {
        process.stderr.write(
          `[${elapsed()}] Invalid report JSON · requesting format-only correction\n`,
        );
      }
      const repairedOutput = await runner.run({
        project,
        projectPath: realPath,
        prompt: buildReportRepairPrompt(profile),
        timeoutMs: Math.min(registry.defaults.timeoutMs, 120_000),
        idleTimeoutMs: Math.min(registry.defaults.idleTimeoutMs, 60_000),
        maxOutputBytes: Math.min(
          registry.defaults.maxReportBytes * 4,
          4_194_304,
        ),
        profile,
        maxSteps: 2,
        sessionId: runRecord.sessionId,
      });
      report = parseReport(
        repairedOutput,
        registry.defaults.maxReportBytes,
        profile,
      );
    }
    const reportPath = await saveReport(statePath, project.name, report);
    if (followMode !== "none")
      process.stderr.write(`[${elapsed()}] Report ready\n`);
    runRecord = {
      ...runRecord,
      status: "success",
      updatedAt: new Date().toISOString(),
      reportPath,
    };
    await writeRunRecord(statePath, runRecord);
    await appendAuditEvent(statePath, {
      timestamp: new Date().toISOString(),
      project: project.name,
      runner: runnerType,
      profile,
      status: "success",
      durationMs: Date.now() - started,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`Report saved to ${reportPath}\n`);
    return 0;
  } catch (error) {
    const relayError =
      error instanceof RelayError
        ? error
        : new RelayError("INTERNAL", "unexpected internal error", 1, {
            cause: error,
          });
    if (runRecord && runnerType) {
      try {
        const status =
          relayError.code === "TIMEOUT"
            ? "timed_out"
            : relayError.code === "INTERRUPTED"
              ? "interrupted"
              : "error";
        runRecord = {
          ...runRecord,
          status,
          updatedAt: new Date().toISOString(),
          errorCode: relayError.code,
        };
        await writeRunRecord(statePath, runRecord);
        await appendAuditEvent(statePath, {
          timestamp: new Date().toISOString(),
          project: runRecord.project,
          runner: runnerType,
          profile: runRecord.profile,
          status,
          durationMs: Date.now() - started,
          errorCode: relayError.code,
          ...(typeof relayError.details.lastEvent === "string"
            ? { lastEvent: relayError.details.lastEvent }
            : {}),
        });
      } catch {
        // Preserve the original error if audit persistence also fails.
      }
    }
    process.stderr.write(`[${relayError.code}] ${relayError.message}\n`);
    return relayError.exitCode;
  } finally {
    if (lockHeld && runRecord) {
      await releaseProjectLock(statePath, runRecord.project, runRecord.id);
    }
  }
}

export function isMainModule(
  moduleUrl: string,
  argumentPath: string | undefined,
): boolean {
  if (!argumentPath) return false;
  try {
    return (
      realpathSync(argumentPath) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1]))
  process.exitCode = await main();

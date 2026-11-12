import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { interruptedError, runnerError, timeoutError } from "./errors.js";
import type {
  QueryProfile,
  Runner,
  RunnerProgressEvent,
  RunnerRequest,
  RunnerType,
} from "./types.js";

const SENSITIVE_READ_PATTERNS = [
  "*.env",
  "*.env.*",
  "**/.env",
  "**/.env.*",
  "**/*.key",
  "**/*.pem",
  "**/*secret*",
  "**/*token*",
  "**/*.dump",
  "**/*.sql",
];
const SENSITIVE_PROGRESS_PATH =
  /(^|[/\\])(\.env(?:\.|$)|.*(?:secret|token|credential|private[-_]?key).*|.*\.(?:key|pem|dump|sql)$)/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeProjectPath(
  value: unknown,
  projectPath: string,
): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const resolved = path.resolve(projectPath, value);
  const relative = path.relative(projectPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    return "[external path hidden]";
  if (SENSITIVE_PROGRESS_PATH.test(relative)) return "[sensitive path hidden]";
  return relative.slice(0, 180) || ".";
}

function tokenCount(
  tokens: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = tokens[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function progressFromOpenCodeLine(
  line: string,
  projectPath: string,
): RunnerProgressEvent | undefined {
  let event: Record<string, unknown>;
  try {
    const parsed = object(JSON.parse(line));
    if (!parsed) return undefined;
    event = parsed;
  } catch {
    return undefined;
  }
  const part = object(event.part);
  const eventType =
    (typeof part?.type === "string" && part.type) ||
    (typeof event.type === "string" && event.type) ||
    "unknown";
  const tool =
    (typeof part?.tool === "string" && part.tool) ||
    (typeof event.tool === "string" && event.tool);
  if (tool) {
    const state = object(part?.state) || object(event.state);
    const input = object(state?.input) || object(event.input);
    const filePath = safeProjectPath(
      input?.filePath ?? input?.path,
      projectPath,
    );
    const action =
      (
        {
          read: "Reading",
          glob: "Searching files",
          grep: "Searching code",
        } as Record<string, string>
      )[tool] || `Using ${tool}`;
    return {
      kind: "activity",
      message: filePath ? `${action}: ${filePath}` : action,
      eventType: `tool:${tool}`,
    };
  }
  if (["step-start", "step_start"].includes(eventType)) {
    return { kind: "activity", message: "Model step started", eventType };
  }
  if (["step-finish", "step_finish"].includes(eventType)) {
    const tokens = object(part?.tokens) || object(event.tokens);
    const input = tokens && tokenCount(tokens, "input");
    const output = tokens && tokenCount(tokens, "output");
    const usage = [
      input !== undefined ? `in ${input}` : undefined,
      output !== undefined ? `out ${output}` : undefined,
    ].filter(Boolean);
    return {
      kind: usage.length ? "usage" : "activity",
      message: usage.length
        ? `Model step finished; tokens ${usage.join(", ")}`
        : "Model step finished",
      eventType,
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
    };
  }
  return undefined;
}

export function sessionIdFromOpenCodeLine(line: string): string | undefined {
  try {
    const event = object(JSON.parse(line));
    const value = event?.sessionID ?? event?.sessionId;
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildOpenCodeArgs(request: RunnerRequest): string[] {
  const args = [
    "run",
    "--pure",
    "--format",
    "json",
    "--agent",
    "relay-research",
    "--dir",
    request.projectPath,
  ];
  if (request.project.runner.model)
    args.push("--model", request.project.runner.model);
  if (request.sessionId) args.push("--session", request.sessionId);
  return args;
}

export function buildOpenCodeConfig(
  source: NodeJS.ProcessEnv = process.env,
  profile: QueryProfile = "implementation",
  maxSteps?: number,
): string {
  const dataHome =
    source.XDG_DATA_HOME ||
    (source.HOME ? `${source.HOME}/.local/share` : undefined);
  const toolOutput = dataHome
    ? `${dataHome}/opencode/tool-output/*`
    : undefined;
  const readRules = Object.fromEntries([
    ["*", "allow"],
    ...SENSITIVE_READ_PATTERNS.map((pattern) => [pattern, "deny"]),
    ...(toolOutput ? [[toolOutput, "deny"]] : []),
  ]);
  return JSON.stringify({
    agent: {
      "relay-research": {
        description: "Read-only local project research for project-agent-relay",
        mode: "primary",
        steps:
          maxSteps ?? { answer: 8, implementation: 20, transfer: 30 }[profile],
        permission: {
          "*": "deny",
          read: readRules,
          glob: "allow",
          grep: "allow",
        },
      },
    },
  });
}

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  profile: QueryProfile = "implementation",
  maxSteps?: number,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed)
    if (source[key] !== undefined) environment[key] = source[key];
  environment.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfig(
    source,
    profile,
    maxSteps,
  );
  return environment;
}

export class OpenCodeRunner implements Runner {
  readonly type = "opencode" as const;

  async run(request: RunnerRequest): Promise<string> {
    const executable = request.project.runner.executable || "opencode";
    const args = buildOpenCodeArgs(request);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: request.projectPath,
        env: sanitizedEnvironment(
          process.env,
          request.profile,
          request.maxSteps,
        ),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.on("error", () => {
        // Process startup and termination failures are reported by the child.
      });
      child.stdin.end(request.prompt, "utf8");
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let terminationError: Error | undefined;
      let killTimeout: NodeJS.Timeout | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let idleTimeout: NodeJS.Timeout | undefined;
      let lineBuffer = "";
      let lastEvent = "runner-start";
      let observedSessionId = request.sessionId;
      const decoder = new StringDecoder("utf8");
      const emit = (event: RunnerProgressEvent) => {
        lastEvent = event.eventType;
        try {
          request.onProgress?.(event);
        } catch {
          // Progress rendering must never affect the runner lifecycle.
        }
      };
      const processLine = (line: string) => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(
          () =>
            terminate(
              timeoutError(
                `runner produced no events for ${request.idleTimeoutMs}ms`,
                { lastEvent },
              ),
            ),
          request.idleTimeoutMs,
        );
        const sessionId = sessionIdFromOpenCodeLine(line);
        if (sessionId && sessionId !== observedSessionId) {
          observedSessionId = sessionId;
          try {
            request.onSessionId?.(sessionId);
          } catch {
            // Session metadata persistence must not interrupt research.
          }
        }
        const progress = progressFromOpenCodeLine(line, request.projectPath);
        if (progress) emit(progress);
      };
      const killProcessGroup = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
      };
      const onSignal = (signal: NodeJS.Signals) =>
        terminate(
          interruptedError(`runner interrupted by ${signal}`, { lastEvent }),
        );
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        clearInterval(heartbeat);
        clearTimeout(idleTimeout);
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        process.off("SIGHUP", onSignal);
        if (error) reject(error);
        else resolve(output || "");
      };
      const terminate = (error: Error) => {
        if (terminationError) return;
        terminationError = error;
        killProcessGroup("SIGTERM");
        killTimeout = setTimeout(() => killProcessGroup("SIGKILL"), 1_000);
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      process.once("SIGHUP", onSignal);
      emit({
        kind: "start",
        message: `OpenCode started for ${request.project.name} · hard timeout ${Math.ceil(request.timeoutMs / 1_000)}s · idle timeout ${Math.ceil(request.idleTimeoutMs / 1_000)}s`,
        eventType: "runner-start",
      });
      const timeout = setTimeout(
        () =>
          terminate(
            timeoutError(`runner timed out after ${request.timeoutMs}ms`, {
              lastEvent,
            }),
          ),
        request.timeoutMs,
      );
      idleTimeout = setTimeout(
        () =>
          terminate(
            timeoutError(
              `runner produced no events for ${request.idleTimeoutMs}ms`,
              { lastEvent },
            ),
          ),
        request.idleTimeoutMs,
      );
      if (request.onProgress) {
        heartbeat = setInterval(
          () =>
            emit({
              kind: "heartbeat",
              message: `Still running; last event: ${lastEvent}`,
              eventType: lastEvent,
            }),
          30_000,
        );
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > request.maxOutputBytes)
          terminate(
            runnerError(
              `runner output exceeds ${request.maxOutputBytes} bytes`,
            ),
          );
        else {
          stdout.push(chunk);
          lineBuffer += decoder.write(chunk);
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 65_536) stderr.push(chunk);
      });
      child.on("error", (error) =>
        finish(
          runnerError(`failed to start ${executable}: ${error.message}`, {
            cause: error,
          }),
        ),
      );
      child.on("close", (code, signal) => {
        lineBuffer += decoder.end();
        if (lineBuffer) processLine(lineBuffer);
        if (terminationError) return finish(terminationError);
        if (code !== 0) {
          const detail = Buffer.concat(stderr)
            .toString("utf8")
            .trim()
            .slice(0, 2_000);
          return finish(
            runnerError(
              `${executable} exited with code ${code}${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`,
            ),
          );
        }
        finish(undefined, Buffer.concat(stdout).toString("utf8"));
      });
    });
  }
}

export class FakeRunner implements Runner {
  readonly type = "fake" as const;

  async run(request: RunnerRequest): Promise<string> {
    request.onSessionId?.(request.sessionId || "fake_session");
    return JSON.stringify({
      summary: `Fake research result for ${request.project.name}`,
      files: [],
      flow: [],
      configuration: [],
      tests: [],
      transferable_practices: [],
      project_specific_details: [],
      risks: [],
      unanswered_questions: ["The fake runner does not inspect project files."],
    });
  }
}

export function runnerFor(type: RunnerType): Runner {
  return type === "opencode" ? new OpenCodeRunner() : new FakeRunner();
}

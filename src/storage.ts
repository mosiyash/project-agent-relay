import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runnerError } from "./errors.js";
import type { QueryProfile, ResearchReport, RunnerType } from "./types.js";

export interface AuditEvent {
  timestamp: string;
  project: string;
  runner: RunnerType;
  profile: QueryProfile;
  status: "success" | "error" | "timed_out" | "interrupted";
  durationMs: number;
  errorCode?: string;
  lastEvent?: string;
}

export type RunStatus =
  "starting" | "running" | "success" | "error" | "timed_out" | "interrupted";

export interface RunRecord {
  schema: 1;
  id: string;
  project: string;
  runner: RunnerType;
  profile: QueryProfile;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  pid: number;
  sessionId?: string;
  reportPath?: string;
  errorCode?: string;
}

export function defaultStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const stateHome =
    environment.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "project-agent-relay");
}

function runPath(statePath: string, runId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(runId))
    throw runnerError(`invalid run id: ${runId}`);
  return path.join(statePath, "runs", `${runId}.json`);
}

export function newRunRecord(
  project: string,
  runner: RunnerType,
  profile: QueryProfile,
): RunRecord {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: randomUUID(),
    project,
    runner,
    profile,
    status: "starting",
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    pid: process.pid,
  };
}

export async function writeRunRecord(
  statePath: string,
  record: RunRecord,
): Promise<void> {
  const destination = runPath(statePath, record.id);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
}

export async function readRunRecord(
  statePath: string,
  runId: string,
): Promise<RunRecord> {
  try {
    const value = JSON.parse(
      await readFile(runPath(statePath, runId), "utf8"),
    ) as RunRecord;
    if (
      value.schema !== 1 ||
      value.id !== runId ||
      typeof value.project !== "string"
    ) {
      throw new Error("invalid run record");
    }
    return value;
  } catch (error) {
    throw runnerError(`cannot read run ${runId}`, { cause: error });
  }
}

export async function latestSuccessfulRun(
  statePath: string,
  project: string,
): Promise<RunRecord | undefined> {
  const directory = path.join(statePath, "runs");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return undefined;
  }
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return JSON.parse(
            await readFile(path.join(directory, file), "utf8"),
          ) as RunRecord;
        } catch {
          return undefined;
        }
      }),
  );
  return records
    .filter(
      (record): record is RunRecord =>
        record?.schema === 1 &&
        record.project === project &&
        record.status === "success" &&
        typeof record.reportPath === "string",
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function lockPath(statePath: string, project: string): string {
  return path.join(statePath, "locks", `${project}.json`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireProjectLock(
  statePath: string,
  project: string,
  runId: string,
): Promise<void> {
  const destination = lockPath(statePath, project);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      destination,
      `${JSON.stringify({ runId, pid: process.pid })}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const current = JSON.parse(await readFile(destination, "utf8")) as {
        runId?: unknown;
        pid?: unknown;
      };
      if (typeof current.pid === "number" && processExists(current.pid)) {
        throw runnerError(
          `project "${project}" already has active run ${String(current.runId)}`,
        );
      }
      await unlink(destination);
      await acquireProjectLock(statePath, project, runId);
    } catch (lockError) {
      if (lockError instanceof Error && lockError.name === "RelayError")
        throw lockError;
      throw runnerError(`cannot acquire project lock for "${project}"`, {
        cause: lockError,
      });
    }
  }
}

export async function releaseProjectLock(
  statePath: string,
  project: string,
  runId: string,
): Promise<void> {
  const destination = lockPath(statePath, project);
  try {
    const current = JSON.parse(await readFile(destination, "utf8")) as {
      runId?: unknown;
    };
    if (current.runId === runId) await unlink(destination);
  } catch {
    // A missing or replaced lock must not hide the original run outcome.
  }
}

export async function saveReport(
  statePath: string,
  project: string,
  report: ResearchReport,
): Promise<string> {
  const directory = path.join(statePath, "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(
    directory,
    `${stamp}-${project}-${randomUUID()}.json`,
  );
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
  return destination;
}

export async function appendAuditEvent(
  statePath: string,
  event: AuditEvent,
): Promise<void> {
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  await appendFile(
    path.join(statePath, "audit.jsonl"),
    `${JSON.stringify(event)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

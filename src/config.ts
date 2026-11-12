import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configError, projectError, RelayError } from "./errors.js";
import type { ProjectConfig, RegistryConfig, RunnerType } from "./types.js";

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RUNNERS = new Set<RunnerType>(["opencode", "fake"]);
const SENSITIVE_INSTRUCTION =
  /(^|[/\\])(\.env(?:\.|$)|.*(?:secret|token|credential|private[-_]?key).*)/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw configError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

function parseProject(value: unknown, index: number): ProjectConfig {
  const entry = object(value, `projects[${index}]`);
  if (typeof entry.name !== "string" || !PROJECT_NAME.test(entry.name)) {
    throw configError(`projects[${index}].name must match ${PROJECT_NAME}`);
  }
  if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
    throw configError(`projects[${index}].aliases must be an array`);
  }
  const aliases = (entry.aliases || []).map((alias, aliasIndex) => {
    if (typeof alias !== "string" || !PROJECT_NAME.test(alias)) {
      throw configError(
        `projects[${index}].aliases[${aliasIndex}] must match ${PROJECT_NAME}`,
      );
    }
    return alias;
  });
  if (
    aliases.includes(entry.name) ||
    new Set(aliases).size !== aliases.length
  ) {
    throw configError(
      `projects[${index}].aliases must be unique and must not include the project name`,
    );
  }
  if (
    typeof entry.path !== "string" ||
    !path.isAbsolute(entry.path) ||
    path.parse(path.resolve(entry.path)).root === path.resolve(entry.path)
  ) {
    throw configError(`projects[${index}].path must be an absolute path`);
  }
  const runner = object(entry.runner, `projects[${index}].runner`);
  if (
    typeof runner.type !== "string" ||
    !RUNNERS.has(runner.type as RunnerType)
  ) {
    throw configError(
      `projects[${index}].runner.type must be one of: opencode, fake`,
    );
  }
  if (
    runner.executable !== undefined &&
    (typeof runner.executable !== "string" || runner.executable.length === 0)
  ) {
    throw configError(
      `projects[${index}].runner.executable must be a non-empty string`,
    );
  }
  if (
    runner.model !== undefined &&
    (typeof runner.model !== "string" || runner.model.length === 0)
  ) {
    throw configError(
      `projects[${index}].runner.model must be a non-empty string`,
    );
  }
  if (!Array.isArray(entry.instructionPaths)) {
    throw configError(`projects[${index}].instructionPaths must be an array`);
  }
  const instructionPaths = entry.instructionPaths.map(
    (item, instructionIndex) => {
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        path.isAbsolute(item) ||
        item.split(/[\\/]/).includes("..") ||
        SENSITIVE_INSTRUCTION.test(item)
      ) {
        throw configError(
          `projects[${index}].instructionPaths[${instructionIndex}] must stay inside the project`,
        );
      }
      return item;
    },
  );
  return {
    name: entry.name,
    aliases,
    path: path.resolve(entry.path),
    runner: {
      type: runner.type as RunnerType,
      ...(typeof runner.executable === "string"
        ? { executable: runner.executable }
        : {}),
      ...(typeof runner.model === "string" ? { model: runner.model } : {}),
    },
    instructionPaths,
  };
}

export function validateRegistry(value: unknown): RegistryConfig {
  const root = object(value, "configuration");
  if (root.version !== 1) throw configError("configuration.version must be 1");
  const defaults = object(root.defaults, "defaults");
  if (!Array.isArray(root.projects) || root.projects.length === 0) {
    throw configError("projects must be a non-empty array");
  }
  const projects = root.projects.map(parseProject);
  const keys = projects.flatMap((project) => [
    project.name,
    ...project.aliases,
  ]);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate)
    throw configError(`duplicate project name or alias: ${duplicate}`);
  return {
    version: 1,
    defaults: {
      timeoutMs: boundedInteger(
        defaults.timeoutMs,
        "defaults.timeoutMs",
        1_000,
        30 * 60_000,
      ),
      idleTimeoutMs: boundedInteger(
        defaults.idleTimeoutMs ?? 120_000,
        "defaults.idleTimeoutMs",
        30_000,
        10 * 60_000,
      ),
      maxReportBytes: boundedInteger(
        defaults.maxReportBytes,
        "defaults.maxReportBytes",
        1_024,
        1_048_576,
      ),
    },
    projects,
  };
}

export function defaultConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configHome =
    environment.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(configHome, "project-agent-relay", "projects.json");
}

export async function loadRegistry(
  configPath: string,
): Promise<RegistryConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw configError(`cannot read configuration at ${configPath}`, {
      cause: error,
    });
  }
  try {
    return validateRegistry(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw configError(`configuration is not valid JSON: ${error.message}`);
    throw error;
  }
}

export async function resolveAllowedProject(
  registry: RegistryConfig,
  name: string,
): Promise<{ project: ProjectConfig; realPath: string }> {
  const project = registry.projects.find(
    (entry) => entry.name === name || entry.aliases.includes(name),
  );
  if (!project) throw projectError(`project "${name}" is not registered`);
  try {
    const projectStat = await stat(project.path);
    if (!projectStat.isDirectory())
      throw projectError(`registered path for "${name}" is not a directory`);
    await access(project.path, constants.R_OK | constants.X_OK);
    return { project, realPath: await realpath(project.path) };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw projectError(`registered path for "${name}" is not accessible`, {
      cause: error,
    });
  }
}

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configError } from "./errors.js";

const SKILL_NAME = "project-agent-relay";
const SKILL_CONTENT = `---
name: project-agent-relay
description: Use ONLY when the user asks to research or obtain information from another registered local project. Calls project-agent-relay with a project name from the local registry and returns its read-only report.
---

# Project Agent Relay

Use this skill only for a request about a different local project, such as "find out in CRM how email delivery works". Do not use it for the current project or for arbitrary filesystem paths.

1. The user's message is addressed to you, the source agent. It is not necessarily a ready-made question for the target project and must not be forwarded mechanically.
2. Identify the registered target project and determine what information must be learned from that project.
3. Derive a self-contained target question addressed directly to the target project's agent:
   - preserve the user's intent rather than their exact wording;
   - phrase the question from the target project's perspective so that "this project" means the target;
   - make it answerable using only files in the target project;
   - remove routing such as "ask mssh" or "узнай у mssh";
   - remove instructions to the source agent such as "let it give you", "then propose", or "пусть он тебе даст";
   - keep facts, constraints, and requested actions about the source/current project in the current session for use after the relay report returns;
   - do not add technical scope, expected files, technologies, constraints, or output requirements that the user did not request.
4. Select exactly one research profile from the user's intent:
   - answer for a narrow fact such as what framework, version, setting, or feature is used;
   - implementation when the user asks how something is implemented or structured;
   - transfer when the user asks how to reproduce, adapt, or apply the target project's approach in the current project.
5. For transfer, never ask the target agent to inspect, describe, or make assumptions about the source project. The source agent applies the returned practices to its own project afterward.
6. Projection examples:
   - User to source: "Посмотри у mssh, как у них оформлены таблицы, и предложи, как сделать у нас." Target question: "Как в этом проекте оформлены таблицы?"
   - User to source: "Как оформлять таблицы, если у нас этого нет во flow? Спроси у mssh, пусть он даст skill или flow." Target question: "Как в этом проекте оформляют таблицы? Есть ли для этого skill или flow?" Source context retained: apply the result to the current project's table flow.
7. Run exactly this command, passing the profile, project name, and projected target question as separate arguments:

   \`project-agent-relay ask --follow --profile <answer|implementation|transfer> --project <registered-name> --question <question>\`

8. On Bash tool calls that run ask or resume, set the tool execution timeout to 960000 milliseconds. This outer timeout must be longer than relay's configured 900000 millisecond hard limit, so relay can enforce its own 120000 millisecond inactivity timeout, stop its process group, and return a structured TIMEOUT error first.
9. Never retry a relay command automatically after a timeout, interruption, or missing result. A retry starts a separate model run and can duplicate token usage. Report the failure to the user and ask before retrying.
10. Every ask prints a Run ID. Keep it in the current session. If the Bash tool is interrupted or returns no final report, do not run ask again:
   - run \`project-agent-relay status --run <id>\`;
   - if status is running, tell the user it is still running and do not start another run;
   - if status is success, recover the report with \`project-agent-relay latest --project <registered-name>\`;
   - if status is error, timed_out, or interrupted, ask the user before continuing the same target session.
11. For a user-approved follow-up or recovery, select a profile for the new question and continue the existing target session:

   \`project-agent-relay resume --follow --profile <answer|implementation|transfer> --run <id> --question <projected-follow-up-question>\`

12. File paths in a relay report are evidence citations, not instructions for you to read another project. Never access those paths directly. If the report lacks necessary detail, use resume and ask the target agent to inspect its own cited files and explain the result.
13. Do not add a target path, runner options, shell redirection, pipes, command substitutions, or other flags.
14. Read the JSON report from stdout and respond according to the profile:
   - answer: return only the direct answer from summary; mention evidence only if the user asks;
   - implementation: explain the implementation with the relevant files, flow, configuration, tests, and risks;
   - transfer: explain the target implementation, distinguish transferable practices from project-specific details, and propose how to apply it in the current project without editing files unless explicitly requested.
15. If the command reports an error, state the error code and message. Do not bypass the registry by searching another project directly.

The relay itself only permits registered projects and invokes its target agent read-only. Never ask it to edit a project or retrieve secrets.
`;

export interface InstallOpenCodeSkillOptions {
  configHome?: string;
  force?: boolean;
}

export interface InstalledOpenCodeSkill {
  skillPath: string;
  configPath: string;
}

function directoryFor(options: InstallOpenCodeSkillOptions): string {
  return (
    options.configHome ||
    process.env.XDG_CONFIG_HOME ||
    path.join(homedir(), ".config")
  );
}

function hasJsoncComments(source: string): boolean {
  return /(^|[^:])\/\/|\/\*/m.test(source);
}

async function existingConfigPath(opencodePath: string): Promise<string> {
  for (const file of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(opencodePath, file);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported configuration filename.
    }
  }
  return path.join(opencodePath, "opencode.json");
}

function mergePermission(source: string, configPath: string): string {
  if (hasJsoncComments(source)) {
    throw configError(
      `cannot safely update ${configPath} because it contains JSONC comments; add the bash permission manually`,
    );
  }
  let config: Record<string, unknown>;
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    config = value as Record<string, unknown>;
  } catch (error) {
    throw configError(`cannot parse ${configPath} as JSON`, { cause: error });
  }
  const permission = config.permission;
  if (
    permission !== undefined &&
    (!permission || typeof permission !== "object" || Array.isArray(permission))
  ) {
    throw configError(
      `cannot merge the bash permission in ${configPath}; permission must be an object`,
    );
  }
  const permissions = (permission || {}) as Record<string, unknown>;
  const bash = permissions.bash;
  if (
    bash !== undefined &&
    (!bash || typeof bash !== "object" || Array.isArray(bash))
  ) {
    throw configError(
      `cannot merge the bash permission in ${configPath}; permission.bash must be an object`,
    );
  }
  const bashRules = {
    ...(bash as Record<string, string> | undefined),
    "project-agent-relay ask *": "allow",
    "project-agent-relay resume *": "allow",
    "project-agent-relay status *": "allow",
    "project-agent-relay latest *": "allow",
  };
  config.permission = { ...permissions, bash: bashRules };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function installOpenCodeSkill(
  options: InstallOpenCodeSkillOptions = {},
): Promise<InstalledOpenCodeSkill> {
  const opencodePath = path.join(directoryFor(options), "opencode");
  const skillPath = path.join(opencodePath, "skills", SKILL_NAME, "SKILL.md");
  const configPath = await existingConfigPath(opencodePath);
  let config = "{}\n";
  try {
    config = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw configError(`cannot read ${configPath}`, { cause: error });
    }
  }
  const updatedConfig = mergePermission(config, configPath);
  try {
    const existingSkill = await readFile(skillPath, "utf8");
    if (existingSkill !== SKILL_CONTENT && !options.force) {
      throw configError(
        `skill already exists at ${skillPath}; rerun with --force to replace it`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
  }
  await mkdir(opencodePath, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, updatedConfig, { encoding: "utf8", mode: 0o600 });
  await writeFile(skillPath, SKILL_CONTENT, { encoding: "utf8", mode: 0o600 });
  return { skillPath, configPath };
}

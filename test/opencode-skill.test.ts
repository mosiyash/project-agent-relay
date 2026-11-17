import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { installOpenCodeSkill } from "../src/opencode-skill.js";

test("installs the global skill and a narrow relay bash permission", async () => {
  const configHome = await mkdtemp(path.join(tmpdir(), "relay-skill-"));
  const result = await installOpenCodeSkill({ configHome });
  const skill = await readFile(result.skillPath, "utf8");
  const config = JSON.parse(await readFile(result.configPath, "utf8")) as {
    permission: { bash: Record<string, string> };
  };
  assert.match(skill, /name: project-agent-relay/);
  assert.match(skill, /Do not add a target path/);
  assert.match(skill, /message is addressed to you, the source agent/);
  assert.match(skill, /not necessarily a ready-made question/);
  assert.match(
    skill,
    /preserve the user's intent rather than their exact wording/,
  );
  assert.match(skill, /answerable using only files in the target project/);
  assert.match(
    skill,
    /keep facts, constraints, and requested actions about the source/,
  );
  assert.match(skill, /answer for a narrow fact/);
  assert.match(skill, /implementation when the user asks how/);
  assert.match(skill, /transfer when the user asks how to reproduce/);
  assert.match(skill, /never ask the target agent to inspect/);
  assert.match(skill, /Как в этом проекте оформляют таблицы/);
  assert.match(skill, /set the tool execution timeout to 960000 milliseconds/);
  assert.match(skill, /Never retry a relay command automatically/);
  assert.match(skill, /project-agent-relay status --run/);
  assert.match(skill, /project-agent-relay resume --follow/);
  assert.equal(config.permission.bash["project-agent-relay ask *"], "allow");
  assert.equal(config.permission.bash["project-agent-relay resume *"], "allow");
  assert.equal(config.permission.bash["project-agent-relay status *"], "allow");
  assert.equal(config.permission.bash["project-agent-relay latest *"], "allow");
  assert.equal(
    config.permission.bash["project-agent-relay register --project *"],
    "allow",
  );
  assert.match(skill, /registers only the current working directory/);
  assert.equal(
    result.skillPath,
    path.join(
      configHome,
      "opencode",
      "skills",
      "project-agent-relay",
      "SKILL.md",
    ),
  );
});

test("preserves existing configuration and requires force for a changed skill", async () => {
  const configHome = await mkdtemp(path.join(tmpdir(), "relay-skill-"));
  const configPath = path.join(configHome, "opencode", "opencode.jsonc");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      model: "example/model",
      permission: { bash: { "git status *": "allow" } },
    }),
  );
  const first = await installOpenCodeSkill({ configHome });
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    model: string;
    permission: { bash: Record<string, string> };
  };
  assert.equal(config.model, "example/model");
  assert.equal(config.permission.bash["git status *"], "allow");
  await writeFile(first.skillPath, "user-owned skill");
  await assert.rejects(
    installOpenCodeSkill({ configHome }),
    (error: unknown) => error instanceof RelayError && error.code === "CONFIG",
  );
  await installOpenCodeSkill({ configHome, force: true });
});

test("refuses to rewrite JSONC comments", async () => {
  const configHome = await mkdtemp(path.join(tmpdir(), "relay-skill-"));
  const configPath = path.join(configHome, "opencode", "opencode.jsonc");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    '{\n  // keep this comment\n  "model": "example/model"\n}\n',
  );
  await assert.rejects(
    installOpenCodeSkill({ configHome }),
    (error: unknown) => error instanceof RelayError && error.code === "CONFIG",
  );
});

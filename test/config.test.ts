import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerCurrentProject,
  resolveAllowedProject,
  validateRegistry,
} from "../src/config.js";
import { RelayError } from "../src/errors.js";

const registry = (projectPath = "/srv/example") => ({
  version: 1,
  defaults: { timeoutMs: 10_000, maxReportBytes: 16_384 },
  projects: [
    {
      name: "crm",
      aliases: ["customer-relations"],
      path: projectPath,
      runner: { type: "opencode" },
      instructionPaths: ["AGENTS.md"],
    },
  ],
});

test("validates a registry with an absolute allowlisted project", () => {
  const result = validateRegistry(registry());
  assert.equal(result.projects[0]?.name, "crm");
  assert.deepEqual(result.projects[0]?.aliases, ["customer-relations"]);
  assert.equal(result.projects[0]?.runner.type, "opencode");
});

test("rejects target paths and instruction paths that escape validation", () => {
  assert.throws(
    () => validateRegistry(registry("relative/project")),
    /absolute path/,
  );
  const invalid = registry();
  invalid.projects[0]!.instructionPaths = ["../secrets.txt"];
  assert.throws(() => validateRegistry(invalid), /stay inside/);
  invalid.projects[0]!.instructionPaths = ["docs/private-token.txt"];
  assert.throws(() => validateRegistry(invalid), /stay inside/);
});

test("rejects duplicate project names and aliases", () => {
  const invalid = registry();
  invalid.projects.push({ ...invalid.projects[0]!, path: "/srv/other" });
  assert.throws(
    () => validateRegistry(invalid),
    /duplicate project name or alias/,
  );
  const aliasCollision = registry();
  aliasCollision.projects.push({
    ...aliasCollision.projects[0]!,
    name: "billing",
    aliases: ["crm"],
    path: "/srv/billing",
  });
  assert.throws(
    () => validateRegistry(aliasCollision),
    /duplicate project name or alias/,
  );
});

test("resolves only registered accessible directories", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-config-"));
  const config = validateRegistry(registry(directory));
  const allowed = await resolveAllowedProject(config, "crm");
  assert.equal(allowed.realPath, directory);
  const aliased = await resolveAllowedProject(config, "customer-relations");
  assert.equal(aliased.project.name, "crm");
  await assert.rejects(
    resolveAllowedProject(config, "unknown"),
    (error: unknown) => error instanceof RelayError && error.code === "PROJECT",
  );
});

test("registers only the canonical current project path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-register-"));
  const configPath = path.join(directory, "config", "projects.json");
  const project = await registerCurrentProject("mailer", configPath, directory);
  assert.equal(project.path, directory);
  assert.deepEqual(project.instructionPaths, []);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.projects[0].name, "mailer");
  await assert.rejects(
    registerCurrentProject("mailer", configPath, directory),
    /already registered/,
  );
});

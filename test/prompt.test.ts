import assert from "node:assert/strict";
import test from "node:test";
import { buildReportRepairPrompt, buildResearchPrompt } from "../src/prompt.js";
import type { ProjectConfig } from "../src/types.js";

const project: ProjectConfig = {
  name: "crm",
  aliases: [],
  path: "/srv/crm",
  runner: { type: "opencode" },
  instructionPaths: ["AGENTS.md", "docs/architecture.md"],
};

test("builds one read-only prompt with instructions and the report contract", () => {
  const prompt = buildResearchPrompt(
    project,
    "How are emails delivered?",
    "implementation",
  );
  assert.match(prompt, /How are emails delivered\?/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /Do not edit, create, delete/);
  assert.match(prompt, /Do not read or expose sensitive material/);
  assert.match(prompt, /"transferable_practices"/);
  assert.match(prompt, /facts verified in code from assumptions/i);
  assert.match(prompt, /Research profile: implementation/);
  assert.match(prompt, /Any third-person reference to the target project/);
});

test("limits answer profile to a direct factual result", () => {
  const prompt = buildResearchPrompt(
    project,
    "Which framework is used?",
    "answer",
  );
  assert.match(prompt, /minimum necessary files/);
  assert.match(prompt, /Do not broaden the question/);
});

test("separates transferable and project-specific details for transfer profile", () => {
  const prompt = buildResearchPrompt(
    project,
    "How can we adopt this?",
    "transfer",
  );
  assert.match(prompt, /transferable practices from project-specific details/);
  assert.match(prompt, /separate calling project, which you cannot access/);
});

test("requests a format-only JSON repair without new research", () => {
  const prompt = buildReportRepairPrompt("implementation");
  assert.match(prompt, /Do not inspect files or perform any new research/);
  assert.match(prompt, /Every collection must use JSON array brackets/);
  assert.match(prompt, /"files": \[\{/);
});

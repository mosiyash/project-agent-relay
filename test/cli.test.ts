import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  isMainModule,
  parseArguments,
  parseResumeArguments,
} from "../src/cli.js";

test("recognizes a globally linked CLI symlink as the main module", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-cli-"));
  const target = path.join(directory, "cli.js");
  const link = path.join(directory, "project-agent-relay");
  await writeFile(target, "");
  await symlink(target, link);

  assert.equal(isMainModule(pathToFileURL(target).href, link), true);
  assert.equal(isMainModule(pathToFileURL(target).href, undefined), false);
});

test("parses --follow independently of valued ask options", () => {
  const options = parseArguments([
    "ask",
    "--follow",
    "--project",
    "crm",
    "--profile",
    "answer",
    "--question",
    "How does it work?",
  ]);
  assert.equal(options.follow, "compact");
  assert.equal(options.project, "crm");
  assert.equal(options.profile, "answer");
});

test("supports detailed follow mode and rejects combined follow modes", () => {
  const detailed = parseArguments([
    "ask",
    "--follow-details",
    "--project",
    "crm",
    "--question",
    "How does it work?",
  ]);
  assert.equal(detailed.follow, "details");
  assert.throws(
    () =>
      parseArguments([
        "ask",
        "--follow",
        "--follow-details",
        "--project",
        "crm",
        "--question",
        "How does it work?",
      ]),
    /only one follow mode/,
  );
});

test("defaults to implementation and rejects unknown profiles", () => {
  const options = parseArguments([
    "ask",
    "--project",
    "crm",
    "--question",
    "How does it work?",
  ]);
  assert.equal(options.profile, "implementation");
  assert.throws(
    () =>
      parseArguments([
        "ask",
        "--project",
        "crm",
        "--profile",
        "huge",
        "--question",
        "How does it work?",
      ]),
    /invalid profile/,
  );
});

test("parses a resumed follow-up with a newly selected profile", () => {
  const options = parseResumeArguments([
    "resume",
    "--follow",
    "--run",
    "00000000-0000-4000-8000-000000000000",
    "--profile",
    "answer",
    "--question",
    "Is an external provider used?",
  ]);
  assert.equal(options.profile, "answer");
  assert.equal(options.follow, "compact");
});

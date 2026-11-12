import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import {
  buildOpenCodeArgs,
  buildOpenCodeConfig,
  OpenCodeRunner,
  progressFromOpenCodeLine,
  sanitizedEnvironment,
  sessionIdFromOpenCodeLine,
} from "../src/runner.js";
import type { RunnerRequest } from "../src/types.js";

function request(executable = "opencode"): RunnerRequest {
  return {
    project: {
      name: "crm",
      aliases: [],
      path: "/srv/crm",
      runner: { type: "opencode", executable },
      instructionPaths: [],
    },
    projectPath: "/srv/crm",
    prompt: "question; rm -rf /",
    timeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxOutputBytes: 4_096,
    profile: "implementation",
  };
}

test("constructs a non-shell OpenCode invocation without prompt text in arguments", () => {
  const args = buildOpenCodeArgs(request());
  assert.deepEqual(args.slice(0, 8), [
    "run",
    "--pure",
    "--format",
    "json",
    "--agent",
    "relay-research",
    "--dir",
    "/srv/crm",
  ]);
  assert.equal(args.includes("question; rm -rf /"), false);
});

test("continues an existing OpenCode session by ID", () => {
  const resumed = { ...request(), sessionId: "ses_existing" };
  const args = buildOpenCodeArgs(resumed);
  assert.deepEqual(args.slice(-2), ["--session", "ses_existing"]);
});

test("extracts a safe OpenCode session ID from JSONL", () => {
  assert.equal(
    sessionIdFromOpenCodeLine(
      JSON.stringify({ sessionID: "ses_abc-123", type: "step_start" }),
    ),
    "ses_abc-123",
  );
  assert.equal(sessionIdFromOpenCodeLine('{"sessionID":"../bad"}'), undefined);
});

test("removes inherited secrets and installs restrictive agent permissions", () => {
  const environment = sanitizedEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    API_TOKEN: "secret",
  });
  assert.equal(environment.API_TOKEN, undefined);
  assert.equal(environment.PATH, "/bin");
  const config = JSON.parse(buildOpenCodeConfig({ HOME: "/home/test" })) as {
    agent: { "relay-research": { permission: Record<string, unknown> } };
  };
  assert.equal(config.agent["relay-research"].permission["*"], "deny");
  assert.equal(config.agent["relay-research"].permission.glob, "allow");
  assert.equal(
    (config.agent["relay-research"].permission.read as Record<string, string>)[
      "/home/test/.local/share/opencode/tool-output/*"
    ],
    "deny",
  );
});

test("sets a profile-specific model step limit", () => {
  const answer = JSON.parse(buildOpenCodeConfig({}, "answer")) as {
    agent: { "relay-research": { steps: number } };
  };
  const transfer = JSON.parse(buildOpenCodeConfig({}, "transfer")) as {
    agent: { "relay-research": { steps: number } };
  };
  assert.equal(answer.agent["relay-research"].steps, 8);
  assert.equal(transfer.agent["relay-research"].steps, 30);
});

test("turns process start failures into a runner error", async () => {
  await assert.rejects(
    new OpenCodeRunner().run(request("definitely-not-a-real-relay-runner")),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "RUNNER" &&
      error.exitCode === 4,
  );
});

test("turns OpenCode JSONL into sanitized progress", () => {
  const readEvent = JSON.stringify({
    type: "tool_use",
    part: {
      type: "tool",
      tool: "read",
      state: {
        input: { filePath: "/srv/crm/src/mail.ts" },
        output: "private source",
      },
    },
  });
  assert.deepEqual(progressFromOpenCodeLine(readEvent, "/srv/crm"), {
    kind: "activity",
    message: "Reading: src/mail.ts",
    eventType: "tool:read",
  });

  const sensitiveEvent = readEvent.replace("src/mail.ts", ".env");
  assert.equal(
    progressFromOpenCodeLine(sensitiveEvent, "/srv/crm")?.message,
    "Reading: [sensitive path hidden]",
  );
  assert.doesNotMatch(
    progressFromOpenCodeLine(readEvent, "/srv/crm")?.message || "",
    /private source/,
  );
});

test("reports aggregate token usage without model text", () => {
  const event = JSON.stringify({
    type: "step_finish",
    part: {
      type: "step-finish",
      tokens: { input: 1200, output: 85 },
      text: "hidden model response",
    },
  });
  const progress = progressFromOpenCodeLine(event, "/srv/crm");
  assert.equal(
    progress?.message,
    "Model step finished; tokens in 1200, out 85",
  );
  assert.equal(progress?.inputTokens, 1200);
  assert.equal(progress?.outputTokens, 85);
  assert.doesNotMatch(progress?.message || "", /hidden model response/);
});

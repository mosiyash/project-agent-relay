import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { parseReport } from "../src/report.js";

const report = {
  summary: "Verified flow",
  files: [{ path: "src/mail.ts", purpose: "Sends mail" }],
  flow: ["Request enters sender"],
  configuration: [{ name: "MAIL_PROVIDER", purpose: "Selects provider" }],
  tests: ["Unit tests cover retries"],
  transferable_practices: [],
  project_specific_details: [],
  risks: [],
  unanswered_questions: [],
};

test("parses a direct structured report", () => {
  assert.deepEqual(parseReport(JSON.stringify(report), 16_384), report);
});

test("normalizes a minimal answer profile without file analysis", () => {
  const result = parseReport(
    JSON.stringify({
      summary: "NotiSend is used.",
      unanswered_questions: [],
    }),
    16_384,
    "answer",
  );
  assert.equal(result.summary, "NotiSend is used.");
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.flow, []);
});

test("extracts report text from OpenCode JSON events", () => {
  const event = JSON.stringify({
    type: "text",
    part: { type: "text", text: JSON.stringify(report) },
  });
  assert.deepEqual(parseReport(event, 16_384), report);
});

test("rejects malformed, oversized, and escaping reports", () => {
  assert.throws(
    () => parseReport("{}", 16_384),
    (error: unknown) => error instanceof RelayError,
  );
  assert.throws(() => parseReport(JSON.stringify(report), 10), /exceeds/);
  assert.throws(
    () =>
      parseReport(
        JSON.stringify({
          ...report,
          files: [{ path: "../secret", purpose: "bad" }],
        }),
        16_384,
      ),
    /project-relative/,
  );
});

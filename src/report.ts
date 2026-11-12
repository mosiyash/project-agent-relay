import { reportError } from "./errors.js";
import type {
  QueryProfile,
  ReportFile,
  ReportSetting,
  ResearchReport,
} from "./types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw reportError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw reportError(`${label} must be a string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw reportError(`${label} must be an array`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function files(value: unknown): ReportFile[] {
  if (!Array.isArray(value)) throw reportError("files must be an array");
  return value.map((item, index) => {
    const entry = record(item, `files[${index}]`);
    const filePath = text(entry.path, `files[${index}].path`);
    if (filePath.startsWith("/") || filePath.split(/[\\/]/).includes("..")) {
      throw reportError(`files[${index}].path must be project-relative`);
    }
    return {
      path: filePath,
      purpose: text(entry.purpose, `files[${index}].purpose`),
    };
  });
}

function settings(value: unknown): ReportSetting[] {
  if (!Array.isArray(value))
    throw reportError("configuration must be an array");
  return value.map((item, index) => {
    const entry = record(item, `configuration[${index}]`);
    return {
      name: text(entry.name, `configuration[${index}].name`),
      purpose: text(entry.purpose, `configuration[${index}].purpose`),
    };
  });
}

export function validateReport(value: unknown): ResearchReport {
  const report = record(value, "report");
  return {
    summary: text(report.summary, "summary"),
    files: files(report.files),
    flow: strings(report.flow, "flow"),
    configuration: settings(report.configuration),
    tests: strings(report.tests, "tests"),
    transferable_practices: strings(
      report.transferable_practices,
      "transferable_practices",
    ),
    project_specific_details: strings(
      report.project_specific_details,
      "project_specific_details",
    ),
    risks: strings(report.risks, "risks"),
    unanswered_questions: strings(
      report.unanswered_questions,
      "unanswered_questions",
    ),
  };
}

function validateAnswerReport(value: unknown): ResearchReport {
  const report = record(value, "report");
  return {
    summary: text(report.summary, "summary"),
    files: [],
    flow: [],
    configuration: [],
    tests: [],
    transferable_practices: [],
    project_specific_details: [],
    risks: [],
    unanswered_questions: strings(
      report.unanswered_questions,
      "unanswered_questions",
    ),
  };
}

function extractJsonText(output: string): string {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "summary" in parsed)
      return trimmed;
  } catch {
    // Fall through to JSONL event extraction.
  }
  const texts: string[] = [];
  for (const line of trimmed.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        part?: { type?: unknown; text?: unknown };
        text?: unknown;
      };
      if (event.part?.type === "text" && typeof event.part.text === "string")
        texts.push(event.part.text);
      else if (event.type === "text" && typeof event.text === "string")
        texts.push(event.text);
    } catch {
      // Non-JSON diagnostic lines cannot contribute to a structured report.
    }
  }
  if (texts.length === 0)
    throw reportError("runner did not return JSON report data");
  return texts.join("").trim();
}

export function parseReport(
  output: string,
  maxBytes: number,
  profile: QueryProfile = "implementation",
): ResearchReport {
  const json = extractJsonText(output);
  if (Buffer.byteLength(json, "utf8") > maxBytes)
    throw reportError(`report exceeds the ${maxBytes}-byte limit`);
  try {
    const parsed = JSON.parse(json) as unknown;
    return profile === "answer"
      ? validateAnswerReport(parsed)
      : validateReport(parsed);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw reportError(
        `runner returned invalid report JSON: ${error.message}`,
      );
    throw error;
  }
}

import type { ProjectConfig, QueryProfile } from "./types.js";

const REPORT_SHAPE = `{
  "summary": "string",
  "files": [{ "path": "relative/path", "purpose": "string" }],
  "flow": ["string"],
  "configuration": [{ "name": "SETTING_NAME", "purpose": "string" }],
  "tests": ["string"],
  "transferable_practices": ["string"],
  "project_specific_details": ["string"],
  "risks": ["string"],
  "unanswered_questions": ["string"]
}`;
const ANSWER_REPORT_SHAPE = `{
  "summary": "direct answer in 1-3 short sentences",
  "unanswered_questions": ["string"]
}`;

const PROFILE_GUIDANCE: Record<QueryProfile, string> = {
  answer:
    "Find only the direct factual answer. Inspect the minimum necessary files, but do not return a file list or implementation analysis. Keep summary to 1-3 short sentences. Do not broaden the question.",
  implementation:
    "Explain how the requested behavior is implemented. Report relevant files, processing flow, configuration names, tests, and concrete risks without exploring unrelated subsystems.",
  transfer:
    "Study the requested implementation for reuse in another project. Clearly separate transferable practices from project-specific details, and include the files, flow, configuration, tests, risks, and unanswered questions needed to evaluate a transfer.",
};

export function buildResearchPrompt(
  project: ProjectConfig,
  question: string,
  profile: QueryProfile,
): string {
  const instructions = project.instructionPaths.length
    ? project.instructionPaths.map((item) => `- ${item}`).join("\n")
    : "- AGENTS.md files discovered inside the project";
  return `You are a read-only research agent working only inside the registered project root.

Question from the caller:
${question}

Perspective: the registered target is the project root you are currently working in (${project.name}). Any third-person reference to the target project, such as "there", "they", "там", "у них", or one of its names, refers to this project. Answer from the perspective of this project and do not look for another project.

Research profile: ${profile}
${PROFILE_GUIDANCE[profile]}

Transfer boundary: when the profile is transfer, you can inspect only this target project. References to "we", "our project", "у нас", or "нам" describe the separate calling project, which you cannot access. Do not infer anything about that project; report only this target project's implementation and transferable practices.

Mandatory rules:
1. Read the project's local instructions first. Explicit instruction paths:
${instructions}
2. Do not edit, create, delete, rename, or format any file. Do not run commands that can mutate files, dependencies, Git state, services, or external systems.
3. Do not read or expose sensitive material, including .env files, credentials, private keys, tokens, secrets, database dumps, backups, or generated secret stores. Examples may be inspected only when clearly non-secret.
4. Stay inside the project root. Do not inspect parent, sibling, home, system, or temporary directories.
5. Cite concrete project-relative file paths. Never include secret values. In configuration, report only setting names and purposes.
6. Clearly distinguish facts verified in code from assumptions. Put unresolved assumptions in unanswered_questions.
7. Return only one valid JSON object matching this exact shape, with every field present:
${profile === "answer" ? ANSWER_REPORT_SHAPE : REPORT_SHAPE}

Use empty arrays when a section has no verified entries. Do not wrap the JSON in Markdown fences and do not add commentary before or after it.`;
}

export function buildContinuationPrompt(
  project: ProjectConfig,
  question: string,
  profile: QueryProfile,
): string {
  return `Continue the existing read-only research session for this registered project (${project.name}).

Follow-up question:
${question}

Research profile: ${profile}
${PROFILE_GUIDANCE[profile]}

Keep all previous safety boundaries: stay inside this project, do not modify files, do not read sensitive files, cite project-relative paths when the selected schema includes files, distinguish verified facts from assumptions, and return only one JSON report matching this required schema:
${profile === "answer" ? ANSWER_REPORT_SHAPE : REPORT_SHAPE}

Use empty arrays for sections with no verified entries. Do not wrap the JSON in Markdown fences.`;
}

export function buildReportRepairPrompt(profile: QueryProfile): string {
  return `Your previous response contained the requested research but was not valid JSON. Do not inspect files or perform any new research. Re-emit the same facts only, as one syntactically valid JSON object matching this exact schema:
${profile === "answer" ? ANSWER_REPORT_SHAPE : REPORT_SHAPE}

Every collection must use JSON array brackets, including collections with one item. Escape all string content correctly. Include every field shown in the schema, use empty arrays when needed, and output no Markdown fences or commentary.`;
}

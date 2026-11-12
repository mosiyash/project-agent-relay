import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import {
  acquireProjectLock,
  latestSuccessfulRun,
  newRunRecord,
  readRunRecord,
  releaseProjectLock,
  writeRunRecord,
} from "../src/storage.js";

test("persists run metadata without question content", async () => {
  const statePath = await mkdtemp(path.join(tmpdir(), "relay-state-"));
  const record = newRunRecord("crm", "opencode", "implementation");
  await writeRunRecord(statePath, record);
  const restored = await readRunRecord(statePath, record.id);
  assert.equal(restored.id, record.id);
  assert.equal(restored.project, "crm");
  assert.equal("question" in restored, false);
});

test("prevents concurrent runs for one project and releases its lock", async () => {
  const statePath = await mkdtemp(path.join(tmpdir(), "relay-state-"));
  const first = newRunRecord("crm", "opencode", "implementation");
  const second = newRunRecord("crm", "opencode", "answer");
  await acquireProjectLock(statePath, "crm", first.id);
  await assert.rejects(
    acquireProjectLock(statePath, "crm", second.id),
    (error: unknown) =>
      error instanceof RelayError && /active run/.test(error.message),
  );
  await releaseProjectLock(statePath, "crm", first.id);
  await acquireProjectLock(statePath, "crm", second.id);
  await releaseProjectLock(statePath, "crm", second.id);
});

test("finds the latest successful report for a canonical project", async () => {
  const statePath = await mkdtemp(path.join(tmpdir(), "relay-state-"));
  const record = {
    ...newRunRecord("crm", "opencode", "answer"),
    status: "success" as const,
    reportPath: path.join(statePath, "reports", "result.json"),
    updatedAt: new Date().toISOString(),
  };
  await writeRunRecord(statePath, record);
  assert.equal((await latestSuccessfulRun(statePath, "crm"))?.id, record.id);
  assert.equal(await latestSuccessfulRun(statePath, "other"), undefined);
});

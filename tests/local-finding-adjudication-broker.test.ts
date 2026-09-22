import test from "node:test";
import assert from "node:assert/strict";
import { DevkitError, LocalFindingAdjudicationBroker, parseFindings, type FindingAdjudicationInspection } from "../src/index.js";

function inspection(overrides: Partial<FindingAdjudicationInspection> = {}): FindingAdjudicationInspection {
  const finding = parseFindings({
    findings: [{
      severity: "P1",
      title: "Potential boundary error",
      path: "src/page.mjs",
      line: 1,
      ruleId: "boundary",
      trigger: "invalid page",
      impact: "token=sk-abcdefghijk must not appear in the local page",
      evidence: ["fixture evidence; not a real model finding"],
    }],
  })[0]!;
  return {
    taskId: "adjudication-task",
    runId: "adjudication-run",
    taskVersion: 7,
    snapshotId: "b".repeat(64),
    finding,
    fingerprint: "a".repeat(64),
    ...overrides,
  };
}

function decision(pending: { approvalId: string; request: { taskId: string; runId: string; snapshotId: string; findingFingerprint: string; fingerprint: string } }, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: pending.approvalId,
    taskId: pending.request.taskId,
    runId: pending.request.runId,
    snapshotId: pending.request.snapshotId,
    findingFingerprint: pending.request.findingFingerprint,
    fingerprint: pending.request.fingerprint,
    action: "confirm",
    operatorId: "local-adjudication-operator",
    ...overrides,
  };
}

test("local finding adjudication broker binds one human decision to the exact high-risk finding", async () => {
  const broker = new LocalFindingAdjudicationBroker({ timeoutMs: 5000 });
  const authorization = broker.authorizeFinding(inspection(), new AbortController().signal);
  const [pending] = broker.pending();
  assert.ok(pending);
  assert.deepEqual({
    taskId: pending.request.taskId,
    runId: pending.request.runId,
    snapshotId: pending.request.snapshotId,
    findingFingerprint: pending.request.findingFingerprint,
    fingerprint: pending.request.fingerprint,
    severity: pending.request.finding.severity,
  }, {
    taskId: "adjudication-task",
    runId: "adjudication-run",
    snapshotId: "b".repeat(64),
    findingFingerprint: inspection().finding.fingerprint,
    fingerprint: "a".repeat(64),
    severity: "P1",
  });
  assert.equal(JSON.stringify(pending.request).includes("sk-abcdefghijk"), false, "the browser presentation receives redacted review text");
  assert.deepEqual(broker.resolve(decision(pending, { findingFingerprint: "d".repeat(64) })), { state: "binding-mismatch" });
  const resolved = broker.resolve(decision(pending));
  assert.equal(resolved.state, "accepted");
  assert.equal((await authorization).action, "confirm");
  assert.equal((await authorization).approvalId, pending.approvalId);
  const audit = broker.audit()[0];
  assert.ok(audit);
  assert.equal(audit.approvalHash === pending.approvalId, false);
  assert.deepEqual({ taskId: audit.taskId, runId: audit.runId, action: audit.action, operatorId: audit.operatorId, reason: audit.reason }, {
    taskId: "adjudication-task", runId: "adjudication-run", action: "confirm", operatorId: "local-adjudication-operator", reason: "operator",
  });
});

test("local finding adjudication broker defers expired, aborted, closed, and saturated work", async () => {
  let now = new Date("2026-09-23T00:00:00.000Z");
  const expiring = new LocalFindingAdjudicationBroker({ timeoutMs: 1000, now: () => now });
  const expired = expiring.authorizeFinding(inspection(), new AbortController().signal);
  const [pending] = expiring.pending();
  assert.ok(pending);
  now = new Date("2026-09-23T00:00:02.000Z");
  assert.deepEqual(expiring.resolve(decision(pending)), { state: "expired" });
  assert.equal((await expired).action, "defer");
  assert.equal(expiring.audit()[0]?.reason, "expired");

  const aborted = new LocalFindingAdjudicationBroker({ timeoutMs: 5000 });
  const controller = new AbortController();
  const abortedRequest = aborted.authorizeFinding(inspection(), controller.signal);
  controller.abort();
  assert.equal((await abortedRequest).action, "defer");
  assert.equal(aborted.audit()[0]?.reason, "aborted");

  const closed = new LocalFindingAdjudicationBroker({ timeoutMs: 5000 });
  const closedRequest = closed.authorizeFinding(inspection(), new AbortController().signal);
  closed.close();
  assert.equal((await closedRequest).action, "defer");
  assert.equal(closed.audit()[0]?.reason, "closed");

  const bounded = new LocalFindingAdjudicationBroker({ timeoutMs: 5000, maxPending: 1 });
  const first = bounded.authorizeFinding(inspection(), new AbortController().signal);
  await assert.rejects(bounded.authorizeFinding(inspection({ taskId: "second-task" }), new AbortController().signal), error => error instanceof DevkitError && error.code === "FINDING_ADJUDICATION_CAPACITY");
  bounded.close();
  assert.equal((await first).action, "defer");
});

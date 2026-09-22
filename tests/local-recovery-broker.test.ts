import test from "node:test";
import assert from "node:assert/strict";
import { DevkitError, LocalRecoveryApprovalBroker, type RecoveryInspection } from "../src/index.js";

function inspection(overrides: Partial<RecoveryInspection> = {}): RecoveryInspection {
  return {
    task: { taskId: "recovery-task" } as RecoveryInspection["task"],
    lease: { resource: "/private/tmp/repository", runId: "recovery-run", acquiredAt: "2026-09-23T00:00:00.000Z" },
    policyCurrent: true,
    baseAvailable: true,
    workspaceState: "changed",
    fingerprint: "a".repeat(64),
    expectedSnapshotId: "b".repeat(64),
    observedSnapshotId: "c".repeat(64),
    ...overrides,
  };
}

function decision(pending: { approvalId: string; request: { taskId: string; runId: string; fingerprint: string } }, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: pending.approvalId,
    taskId: pending.request.taskId,
    runId: pending.request.runId,
    fingerprint: pending.request.fingerprint,
    decision: "accept",
    oldWriterStopped: true,
    operatorId: "local-operator",
    ...overrides,
  };
}

test("local recovery broker binds one human proof to the exact retained run", async () => {
  const broker = new LocalRecoveryApprovalBroker({ timeoutMs: 5000 });
  const authorization = broker.authorizeRecovery(inspection());
  const [pending] = broker.pending();
  assert.ok(pending);
  assert.deepEqual(pending.request, {
    taskId: "recovery-task",
    runId: "recovery-run",
    fingerprint: "a".repeat(64),
    workspaceState: "changed",
    policyCurrent: true,
    baseAvailable: true,
    expectedSnapshotId: "b".repeat(64),
    observedSnapshotId: "c".repeat(64),
  });
  assert.throws(() => broker.resolve(decision(pending, { oldWriterStopped: false })), /RECOVERY_APPROVAL_PROOF_REQUIRED/);
  assert.deepEqual(broker.resolve(decision(pending, { fingerprint: "d".repeat(64) })), { state: "binding-mismatch" });
  const resolved = broker.resolve(decision(pending));
  assert.equal(resolved.state, "accepted");
  assert.equal((await authorization).oldWriterStopped, true);
  assert.equal((await authorization).approvalId, pending.approvalId);
  const audit = broker.audit()[0];
  assert.ok(audit);
  assert.equal(audit.approvalHash === pending.approvalId, false);
  assert.deepEqual({ taskId: audit.taskId, runId: audit.runId, decision: audit.decision, operatorId: audit.operatorId, reason: audit.reason }, {
    taskId: "recovery-task", runId: "recovery-run", decision: "accept", operatorId: "local-operator", reason: "operator",
  });
});

test("local recovery broker declines expired, closed, and saturated requests without releasing a lease", async () => {
  let now = new Date("2026-09-23T00:00:00.000Z");
  const expiring = new LocalRecoveryApprovalBroker({ timeoutMs: 1000, now: () => now });
  const expired = expiring.authorizeRecovery(inspection());
  const [pending] = expiring.pending();
  assert.ok(pending);
  now = new Date("2026-09-23T00:00:02.000Z");
  assert.deepEqual(expiring.resolve(decision(pending)), { state: "expired" });
  await assert.rejects(expired, /RECOVERY_APPROVAL_EXPIRED/);
  assert.equal(expiring.audit()[0]?.decision, "decline");
  assert.equal(expiring.audit()[0]?.reason, "expired");

  const closed = new LocalRecoveryApprovalBroker({ timeoutMs: 5000 });
  const closedRequest = closed.authorizeRecovery(inspection());
  closed.close();
  await assert.rejects(closedRequest, /RECOVERY_APPROVAL_CLOSED/);
  assert.equal(closed.audit()[0]?.reason, "closed");

  const bounded = new LocalRecoveryApprovalBroker({ timeoutMs: 5000, maxPending: 1 });
  const first = bounded.authorizeRecovery(inspection());
  await assert.rejects(bounded.authorizeRecovery(inspection({ task: { taskId: "second-task" } as RecoveryInspection["task"] })), /RECOVERY_APPROVAL_CAPACITY/);
  bounded.close();
  await assert.rejects(first, error => error instanceof DevkitError && error.code === "RECOVERY_APPROVAL_CLOSED");
});

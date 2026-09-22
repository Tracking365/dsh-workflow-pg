import assert from "node:assert/strict";
import test from "node:test";
import { LocalCodexApprovalBroker, type CodexAppServerApprovalRequest } from "../src/index.js";

function approval(overrides: Partial<CodexAppServerApprovalRequest> = {}): CodexAppServerApprovalRequest {
  return {
    taskId: "task-approval",
    kind: "command",
    requestId: "string:request-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    fingerprint: "f".repeat(64),
    cwd: "/private/tmp/candidate",
    command: "node --test",
    ...overrides,
  };
}

test("local approval broker binds a one-time human decision to exact task facts", async () => {
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 1000 });
  const pendingDecision = broker.decide(approval(), new AbortController().signal);
  const [pending] = broker.pending();
  assert.ok(pending);
  assert.equal(broker.resolve({
    approvalId: pending.approvalId,
    taskId: "wrong-task",
    fingerprint: approval().fingerprint,
    decision: "accept",
    operatorId: "operator-1",
  }).state, "binding-mismatch");
  assert.equal(broker.pending().length, 1, "a mismatched reply cannot consume the request");

  const resolved = broker.resolve({
    approvalId: pending.approvalId,
    taskId: approval().taskId,
    fingerprint: approval().fingerprint,
    decision: "accept",
    operatorId: "operator-1",
  });
  assert.equal(resolved.state, "accepted");
  assert.equal(await pendingDecision, "accept");
  assert.deepEqual(broker.pending(), []);
  const [audit] = broker.audit();
  assert.ok(audit);
  assert.equal(audit.decision, "accept");
  assert.equal(audit.operatorId, "operator-1");
  assert.equal(audit.reason, "operator");
  assert.notEqual(audit.approvalHash, pending.approvalId, "audit retains only the approval hash");
  assert.throws(() => broker.resolve({ ...pending, operatorId: "operator-1", decision: "accept" }), /UNKNOWN_FIELD|INVALID_CODEX/);
});

test("local approval broker declines aborted, expired and closing requests", async () => {
  const controller = new AbortController();
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 1000 });
  const aborted = broker.decide(approval(), controller.signal);
  controller.abort();
  assert.equal(await aborted, "decline");
  assert.equal(broker.audit()[0]?.reason, "aborted");

  let now = new Date("2026-09-23T00:00:00.000Z");
  const expiring = new LocalCodexApprovalBroker({ timeoutMs: 1000, now: () => now });
  const pendingExpiry = expiring.decide(approval(), new AbortController().signal);
  const [pending] = expiring.pending();
  assert.ok(pending);
  now = new Date("2026-09-23T00:00:02.000Z");
  assert.equal(expiring.resolve({
    approvalId: pending.approvalId,
    taskId: approval().taskId,
    fingerprint: approval().fingerprint,
    decision: "accept",
    operatorId: "operator-2",
  }).state, "expired");
  assert.equal(await pendingExpiry, "decline");
  assert.equal(expiring.audit()[0]?.reason, "expired");

  const closing = new LocalCodexApprovalBroker({ timeoutMs: 1000 });
  const pendingClose = closing.decide(approval(), new AbortController().signal);
  closing.close();
  assert.equal(await pendingClose, "decline");
  assert.equal(closing.audit()[0]?.reason, "closed");
});

test("local approval broker bounds pending work and retained audit evidence", async () => {
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 1000, maxPending: 1, maxAuditEntries: 1 });
  const firstDecision = broker.decide(approval(), new AbortController().signal);
  const [first] = broker.pending();
  assert.ok(first);
  assert.equal(await broker.decide(approval({ taskId: "overflow-task" }), new AbortController().signal), "decline");
  assert.equal(broker.pending().length, 1);
  assert.equal(broker.resolve({
    approvalId: first.approvalId,
    taskId: first.request.taskId,
    fingerprint: first.request.fingerprint,
    decision: "decline",
    operatorId: "operator-3",
  }).state, "accepted");
  assert.equal(await firstDecision, "decline");

  const secondDecision = broker.decide(approval({ taskId: "second-task" }), new AbortController().signal);
  const [second] = broker.pending();
  assert.ok(second);
  assert.equal(broker.resolve({
    approvalId: second.approvalId,
    taskId: second.request.taskId,
    fingerprint: second.request.fingerprint,
    decision: "accept",
    operatorId: "operator-3",
  }).state, "accepted");
  assert.equal(await secondDecision, "accept");
  assert.equal(broker.audit().length, 1);
  assert.equal(broker.audit()[0]?.taskId, "second-task");
});

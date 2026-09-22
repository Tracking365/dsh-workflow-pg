import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Devkit, LocalRecoveryApprovalBroker, LocalRecoveryControlPlane } from "../src/index.js";
import { adapters, fixture, input } from "./helpers.js";

const secret = "local-recovery-control-secret-32-bytes!";

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function eventually<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function interruptedRuntime() {
  const f = fixture();
  let workspace = "";
  const broker = new LocalRecoveryApprovalBroker({ timeoutMs: 5000 });
  const runtime = new Devkit(f.policy, {
    ...adapters({ execute: async request => {
      workspace = request.workspace;
      return { stopped: false, runId: "unconfirmed-old-writer" };
    } }),
    recoveryAuthority: broker,
  });
  const task = runtime.create(input);
  const result = await runtime.run(task.taskId);
  assert.equal(result.status, "interrupted");
  assert.equal(runtime.store.hasLease(task.taskId), true);
  return { f, broker, runtime, task, workspace: () => workspace };
}

async function login(url: string): Promise<{ cookie: string; csrf: string }> {
  const opened = await fetch(`${url}/session`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ token: secret }),
  });
  assert.equal(opened.status, 303);
  const setCookie = opened.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0]!;
  const home = await fetch(`${url}/`, { headers: { Cookie: cookie } });
  const html = await home.text();
  const csrf = /name=csrf value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  return { cookie, csrf };
}

test("loopback recovery control plane requires an authenticated old-writer proof before it queues a fresh clone", async () => {
  const { broker, runtime, task, workspace } = await interruptedRuntime();
  const plane = new LocalRecoveryControlPlane({
    broker,
    credential: () => secret,
    operatorId: "local-recovery-operator",
    recover: async taskId => await runtime.recover(taskId),
  });
  const { url } = await plane.start();
  try {
    const unauthenticated = await fetch(`${url}/recoveries`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf: "no-session", taskId: task.taskId }),
    });
    assert.equal(unauthenticated.status, 401);
    const page = await fetch(`${url}/`);
    assert.equal((await page.text()).includes(secret), false);

    const { cookie, csrf } = await login(url);
    const badCsrf = await fetch(`${url}/recoveries`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf: "wrong", taskId: task.taskId }),
    });
    assert.equal(badCsrf.status, 403);
    const requested = await fetch(`${url}/recoveries`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, taskId: task.taskId }),
    });
    assert.equal(requested.status, 303);
    const pending = await eventually(() => broker.pending()[0], "recovery approval did not become pending");
    assert.equal(pending.request.taskId, task.taskId);
    assert.equal(pending.request.runId, runtime.status(task.taskId).runId);
    assert.equal(broker.pending().length, 1);

    const home = await fetch(`${url}/`, { headers: { Cookie: cookie } });
    const html = await home.text();
    assert.match(html, /Interrupted-task recovery/);
    assert.equal(html.includes(input.description), false, "task prose must not be rendered into the control page");
    const noProof = await fetch(`${url}/recoveries/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, decision: "accept" }),
    });
    assert.equal(noProof.status, 403);
    assert.equal(broker.pending().length, 1);

    const accepted = await fetch(`${url}/recoveries/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, decision: "accept", oldWriterStopped: "yes" }),
    });
    assert.equal(accepted.status, 303);
    const requeued = await eventually(() => runtime.status(task.taskId).status === "queued" ? runtime.status(task.taskId) : undefined, "recovery did not requeue");
    assert.equal(requeued.reason, "recovery_authorized");
    assert.equal(requeued.workspace, undefined);
    assert.equal(runtime.store.hasLease(task.taskId), false);
    assert.equal(existsSync(workspace()), true, "the old candidate remains available for inspection");
    assert.equal(JSON.stringify(runtime.store.history(task.taskId)).includes(pending.approvalId), false);
    assert.equal(broker.audit()[0]?.operatorId, "local-recovery-operator");
  } finally {
    await plane.stop();
    await runtime.close();
  }
});

test("stopping the recovery control plane declines a pending request and preserves its retained lease", async () => {
  const { broker, runtime, task } = await interruptedRuntime();
  const plane = new LocalRecoveryControlPlane({
    broker,
    credential: () => secret,
    operatorId: "local-recovery-operator",
    recover: async taskId => await runtime.recover(taskId),
  });
  const { url } = await plane.start();
  try {
    const { cookie, csrf } = await login(url);
    const requested = await fetch(`${url}/recoveries`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, taskId: task.taskId }),
    });
    assert.equal(requested.status, 303);
    await eventually(() => broker.pending()[0], "recovery approval did not become pending");
    await plane.stop();
    await eventually(() => runtime.status(task.taskId).status === "interrupted" && broker.audit()[0]?.reason === "closed" ? runtime.status(task.taskId) : undefined, "recovery close did not retain the task");
    assert.equal(runtime.store.hasLease(task.taskId), true);
    await assert.rejects(fetch(`${url}/`));
  } finally {
    await plane.stop();
    await runtime.close();
  }
});

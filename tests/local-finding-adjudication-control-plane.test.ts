import test from "node:test";
import assert from "node:assert/strict";
import { Devkit, LocalFindingAdjudicationBroker, LocalFindingAdjudicationControlPlane, parseFindings } from "../src/index.js";
import { adapters, fixture, input } from "./helpers.js";

const secret = "local-adjudication-control-secret-32-bytes!";

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function eventually<T>(read: () => T | undefined, message: string): Promise<T> {
  // The whole suite intentionally starts several independent Node workers.
  // Keep this bounded but leave enough scheduling room for the candidate's
  // real Git/TAP fixture to reach the local broker on a loaded host.
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function pendingFindingRun() {
  const f = fixture();
  const broker = new LocalFindingAdjudicationBroker({ timeoutMs: 5000 });
  let reviews = 0;
  const highFinding = parseFindings({
    findings: [{
      severity: "P1",
      title: "<img src=x onerror=alert(1)>",
      path: "src/page.mjs",
      line: 1,
      ruleId: "boundary",
      trigger: "invalid page",
      impact: "token=sk-abcdefghijk must remain redacted",
      evidence: ["fixture evidence; not a real model finding"],
    }],
  })[0]!;
  const runtime = new Devkit(f.policy, {
    ...adapters({ review: async request => ({
      snapshotId: request.snapshotId,
      reviewerId: "fixture-reviewer",
      provider: "fixture",
      model: "fixture-only-not-a-model",
      findings: reviews++ === 0 ? [highFinding] : [],
    }) }),
    findingAdjudicator: broker,
  });
  const task = runtime.create(input);
  const running = runtime.run(task.taskId);
  const pending = await eventually(() => broker.pending()[0], "finding adjudication did not become pending");
  return { broker, runtime, task, running, pending };
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

test("loopback finding-adjudication control plane requires an authenticated confirmation before retrying", async () => {
  const { broker, runtime, task, running, pending } = await pendingFindingRun();
  const plane = new LocalFindingAdjudicationControlPlane({
    broker,
    credential: () => secret,
    operatorId: "local-adjudication-operator",
  });
  const { url } = await plane.start();
  try {
    const unauthenticated = await fetch(`${url}/adjudications/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf: "no-session", action: "defer" }),
    });
    assert.equal(unauthenticated.status, 401);
    const page = await fetch(`${url}/`);
    assert.equal((await page.text()).includes(secret), false);

    const { cookie, csrf } = await login(url);
    const home = await fetch(`${url}/`, { headers: { Cookie: cookie } });
    const html = await home.text();
    assert.match(html, /High-risk review findings/);
    assert.equal(html.includes(input.description), false, "task prose must not be rendered into the adjudication page");
    assert.equal(html.includes("<img src=x onerror"), false, "untrusted finding text must be escaped");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(html.includes("sk-abcdefghijk"), false, "redaction happens before browser rendering");

    const badCsrf = await fetch(`${url}/adjudications/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf: "wrong", action: "defer" }),
    });
    assert.equal(badCsrf.status, 403);
    const noConfirmation = await fetch(`${url}/adjudications/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, action: "confirm" }),
    });
    assert.equal(noConfirmation.status, 403);
    assert.equal(broker.pending().length, 1);

    const confirmed = await fetch(`${url}/adjudications/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, action: "confirm", confirmRequiresRepair: "yes" }),
    });
    assert.equal(confirmed.status, 303);
    const result = await running;
    assert.equal(result.status, "awaiting_human");
    assert.equal(result.reason, "final_acceptance");
    assert.equal(result.readyForAcceptance, true);
    assert.equal(runtime.store.hasLease(task.taskId), false);
    assert.equal(JSON.stringify(runtime.store.history(task.taskId)).includes(pending.approvalId), false);
    assert.equal(JSON.stringify(runtime.report(task.taskId)).includes("sk-abcdefghijk"), false, "report output must not leak reviewer-supplied secret-like text");
    assert.equal(broker.audit()[0]?.operatorId, "local-adjudication-operator");
  } finally {
    await plane.stop();
    await running.catch(() => undefined);
    await runtime.close();
  }
});

test("stopping the finding-adjudication control plane defers the finding and releases the stopped writer", async () => {
  const { broker, runtime, task, running } = await pendingFindingRun();
  const plane = new LocalFindingAdjudicationControlPlane({
    broker,
    credential: () => secret,
    operatorId: "local-adjudication-operator",
  });
  const { url } = await plane.start();
  try {
    await plane.stop();
    const result = await running;
    assert.equal(result.status, "awaiting_human");
    assert.equal(result.reason, "unconfirmed_high_risk");
    assert.equal(result.readyForAcceptance, false);
    assert.equal(runtime.store.hasLease(task.taskId), false);
    assert.equal(broker.audit()[0]?.reason, "closed");
    await assert.rejects(fetch(`${url}/`));
  } finally {
    await plane.stop();
    await running.catch(() => undefined);
    await runtime.close();
  }
});

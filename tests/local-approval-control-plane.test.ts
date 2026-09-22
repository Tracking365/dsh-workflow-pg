import assert from "node:assert/strict";
import test from "node:test";
import { LocalApprovalControlPlane, LocalCodexApprovalBroker, type CodexAppServerApprovalRequest } from "../src/index.js";

const secret = "local-control-plane-secret-32-bytes!";

function approval(): CodexAppServerApprovalRequest {
  return {
    taskId: "task-local-ui",
    kind: "command",
    requestId: "string:ui-request",
    threadId: "thread-ui",
    turnId: "turn-ui",
    itemId: "item-ui",
    fingerprint: "a".repeat(64),
    cwd: "/private/tmp/candidate",
    command: "<img src=x onerror=alert(1)>",
    reason: "review this synthetic command",
  };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

test("loopback approval control plane authenticates a human session and resolves only broker-pending work", async () => {
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 5000 });
  const plane = new LocalApprovalControlPlane({ broker, credential: () => secret, operatorId: "local-operator" });
  const pendingDecision = broker.decide(approval(), new AbortController().signal);
  const [pending] = broker.pending();
  assert.ok(pending);
  const { url } = await plane.start();
  try {
    const login = await fetch(`${url}/`);
    assert.equal(login.status, 200);
    const loginHtml = await login.text();
    assert.match(loginHtml, /Local approval secret/);
    assert.equal(loginHtml.includes(secret), false);

    const rejectedOrigin = await fetch(`${url}/session`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: "http://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: secret }),
    });
    assert.equal(rejectedOrigin.status, 403);

    const opened = await fetch(`${url}/session`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: secret }),
    });
    assert.equal(opened.status, 303);
    const setCookie = opened.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.equal(setCookie.includes(secret), false);
    const cookie = setCookie.split(";", 1)[0]!;

    const home = await fetch(`${url}/`, { headers: { Cookie: cookie } });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.equal(html.includes("<img src=x"), false, "model-controlled command text must be escaped");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const csrf = /name=csrf value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);

    const resolved = await fetch(`${url}/approvals/${encodeURIComponent(pending.approvalId)}`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ csrf, decision: "accept" }),
    });
    assert.equal(resolved.status, 303);
    assert.equal(await pendingDecision, "accept");
    assert.equal(broker.audit()[0]?.operatorId, "local-operator");
    assert.equal(broker.audit()[0]?.decision, "accept");
  } finally {
    await plane.stop();
  }
});

test("stopping the loopback control plane declines unsettled work and removes its listener", async () => {
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 5000 });
  const plane = new LocalApprovalControlPlane({ broker, credential: () => secret, operatorId: "local-operator" });
  const pendingDecision = broker.decide(approval(), new AbortController().signal);
  const { url } = await plane.start();
  await plane.stop();
  assert.equal(await pendingDecision, "decline");
  await assert.rejects(fetch(`${url}/`));
});

test("loopback approval control plane bounds authenticated browser sessions", async () => {
  const broker = new LocalCodexApprovalBroker({ timeoutMs: 5000 });
  const plane = new LocalApprovalControlPlane({ broker, credential: () => secret, operatorId: "local-operator" });
  const { url } = await plane.start();
  try {
    for (let index = 0; index < 32; index += 1) {
      const opened = await fetch(`${url}/session`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ token: secret }),
      });
      assert.equal(opened.status, 303);
    }
    const saturated = await fetch(`${url}/session`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: url, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: secret }),
    });
    assert.equal(saturated.status, 429);
  } finally {
    await plane.stop();
  }
});

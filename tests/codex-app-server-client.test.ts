import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerExecutor, MacosSeatbeltAppServerClientLaunch, type CodexAppServerApprovalRequest, type CodexAppServerClientLaunch, type ExecutionRequest, type TaskRecord } from "../src/index.js";

type Message = Record<string, unknown>;

class FakeAppServer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Message[] = [];
  readonly done: Promise<unknown>;
  terminateCalls = 0;
  releaseCalls: boolean[] = [];
  private buffer = "";
  private complete!: (value: unknown) => void;

  constructor(
    private readonly onMessage: (message: Message, server: FakeAppServer) => void,
    private readonly exitConfirmed = true,
    private readonly releaseConfirmed = true,
  ) {
    this.done = new Promise(resolve => { this.complete = resolve; });
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Message;
        this.received.push(message);
        this.onMessage(message, this);
      }
    });
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  finish(): void {
    this.stdout.end();
    this.stderr.end();
    this.complete({ exitCode: 0 });
  }

  launch(): CodexAppServerClientLaunch {
    return {
      id: "fake-app-server",
      prepare: async () => ({
        child: {
          stdin: this.stdin,
          stdout: this.stdout,
          stderr: this.stderr,
          control: undefined,
          collected: {},
          done: this.done,
          terminate: () => {
            this.terminateCalls += 1;
            this.finish();
          },
          waitForExit: async () => {
            if (!this.exitConfirmed) return false;
            await this.done;
            return true;
          },
        },
        release: async stopped => {
          this.releaseCalls.push(stopped);
          return this.releaseConfirmed;
        },
      }),
    };
  }
}

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-app-server-client-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "test"));
  writeFileSync(path.join(root, "src", "page.mjs"), "export const page = 1;\n");
  return root;
}

function request(work: string, signal = new AbortController().signal): ExecutionRequest {
  const task: TaskRecord = {
    schemaVersion: 1,
    taskId: "task-app-server-client",
    inputHash: "input-hash",
    input: {
      kind: "bugfix",
      title: "Exercise App Server protocol",
      description: "Use a fake App Server only.",
      repositoryRef: "fixture",
      reproduction: { steps: ["run a fixture"], expected: "fail", actual: "fail" },
      acceptanceCriteria: [{ id: "A1", description: "fake protocol completes" }],
      verificationProfile: "regression",
    },
    status: "running",
    stage: "implement",
    retryCount: 0,
    readyForAcceptance: false,
    version: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    policyHash: "policy-hash",
    baseCommit: "0".repeat(40),
    workspace: work,
    snapshotId: "snapshot-id",
    runId: "run-id",
  };
  return {
    task,
    workspace: work,
    snapshot: { id: "snapshot-id", baseCommit: "0".repeat(40), files: [], policyHash: "policy-hash", planHash: "plan-hash" },
    feedback: "",
    signal,
    allowedPaths: ["src/"],
    protectedPaths: ["test/"],
  };
}

function id(message: Message): string | number {
  const value = message.id;
  assert.ok(typeof value === "string" || typeof value === "number");
  return value;
}

function result(message: Message): Record<string, unknown> {
  assert.ok(message.result && typeof message.result === "object" && !Array.isArray(message.result));
  return message.result as Record<string, unknown>;
}

test("direct App Server client binds the turn to one candidate workspace and routes only in-scope approvals", async () => {
  const work = workspace();
  const canonicalWork = realpathSync(work);
  const approvals: CodexAppServerApprovalRequest[] = [];
  let stage = 0;
  const server = new FakeAppServer((message, fake) => {
    if (message.method === "initialize") {
      fake.send({ id: id(message), result: { platformFamily: "unix" } });
      return;
    }
    if (message.method === "thread/start") {
      fake.send({ id: id(message), result: { thread: { id: "thread-1", ephemeral: true } } });
      return;
    }
    if (message.method === "turn/start") {
      fake.send({ id: id(message), result: { turn: { id: "turn-1", status: "inProgress" } } });
      queueMicrotask(() => {
        fake.send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
          id: "command-item", type: "commandExecution", command: "node --test test/page.test.mjs", cwd: work,
        } } });
        fake.send({ method: "item/commandExecution/requestApproval", id: "command-1", params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "command-item", reason: "run regression",
        } });
      });
      return;
    }
    if (message.id === "command-1") {
      assert.deepEqual(result(message), { decision: "accept" });
      stage += 1;
      fake.send({ method: "item/started", params: { threadId: "other-thread", turnId: "turn-1", item: {
        id: "foreign-file-item", type: "fileChange", changes: [{ path: "src/page.mjs", kind: "update", diff: "ignored" }],
      } } });
      fake.send({ method: "item/fileChange/requestApproval", id: "foreign-file", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "foreign-file-item", grantRoot: work,
      } });
      return;
    }
    if (message.id === "foreign-file") {
      assert.deepEqual(result(message), { decision: "decline" });
      fake.send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
        id: "file-item", type: "fileChange", changes: [{ path: "src/page.mjs", kind: "update", diff: "ignored" }],
      } } });
      fake.send({ method: "item/fileChange/requestApproval", id: "file-1", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-item", grantRoot: work, reason: "apply scoped fix",
      } });
      return;
    }
    if (message.id === "file-1") {
      assert.deepEqual(result(message), { decision: "accept" });
      stage += 1;
      fake.send({ method: "item/commandExecution/requestApproval", id: "cross-thread", params: {
        threadId: "other-thread", turnId: "turn-1", itemId: "other-item", cwd: work, command: "echo not-approved",
      } });
      return;
    }
    if (message.id === "cross-thread") {
      assert.deepEqual(result(message), { decision: "decline" });
      fake.send({ method: "item/commandExecution/requestApproval", id: "network", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "network-item", cwd: work, command: "curl https://example.invalid", networkApprovalContext: { host: "example.invalid", protocol: "https" },
      } });
      return;
    }
    if (message.id === "network") {
      assert.deepEqual(result(message), { decision: "decline" });
      fake.send({ method: "item/commandExecution/requestApproval", id: "policy-amendment", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "policy-item", cwd: work, command: "node --test test/page.test.mjs",
        additionalPermissions: { filesystem: ["/private/tmp"] },
        proposedExecpolicyAmendment: { execpolicy_amendment: ["node", "--test"] },
        commandActions: [{ type: "run" }],
      } });
      return;
    }
    if (message.id === "policy-amendment") {
      assert.deepEqual(result(message), { decision: "decline" });
      fake.send({ method: "item/permissions/requestApproval", id: "permissions", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "permissions-item", cwd: work, permissions: { network: ["example.invalid"] },
      } });
      return;
    }
    if (message.id === "permissions") {
      assert.deepEqual(result(message), { permissions: {}, scope: "turn" });
      fake.send({ method: "item/tool/requestUserInput", id: "user-input", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "user-input-item", questions: [{ id: "secret", question: "supply a secret" }],
      } });
      return;
    }
    if (message.id === "user-input") {
      assert.deepEqual(result(message), { answers: {} });
      fake.send({ method: "mcpServer/elicitation/request", id: "mcp-elicitation", params: {
        threadId: "thread-1", turnId: "turn-1", serverName: "untrusted", mode: "form", message: "supply a credential",
      } });
      return;
    }
    if (message.id === "mcp-elicitation") {
      assert.deepEqual(result(message), { action: "decline", content: null, _meta: null });
      fake.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }
  });

  const executor = new CodexAppServerExecutor({
    launch: server.launch(),
    approvalBroker: {
      async decide(approval) {
        approvals.push(approval);
        return "accept";
      },
    },
  });
  const outcome = await executor.execute(request(work));

  assert.deepEqual(outcome, { stopped: true, runId: "thread-1:turn-1" });
  assert.equal(stage, 2);
  assert.equal(approvals.length, 2, "cross-thread and network requests must never reach the human broker");
  assert.deepEqual(approvals.map(approval => ({ kind: approval.kind, paths: approval.paths, command: approval.command })), [
    { kind: "command", paths: undefined, command: "node --test test/page.test.mjs" },
    { kind: "file-change", paths: ["src/page.mjs"], command: undefined },
  ]);
  assert.notEqual(approvals[0]!.fingerprint, approvals[1]!.fingerprint);
  const turnStart = server.received.find(message => message.method === "turn/start");
  assert.ok(turnStart);
  const parameters = turnStart.params as Record<string, unknown>;
  assert.equal(parameters.cwd, canonicalWork);
  assert.equal(parameters.approvalPolicy, "onRequest");
  assert.deepEqual(parameters.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [canonicalWork],
    readOnlyAccess: { type: "restricted", includePlatformDefaults: true, readableRoots: [canonicalWork] },
    networkAccess: false,
  });
  const threadStart = server.received.find(message => message.method === "thread/start");
  assert.ok(threadStart);
  assert.deepEqual(threadStart.params, {
    cwd: canonicalWork,
    ephemeral: true,
    approvalPolicy: "onRequest",
    approvalsReviewer: "user",
    sandbox: "workspaceWrite",
  });
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
  assert.equal(server.received.some(message => {
    const approval = message.result as Record<string, unknown> | undefined;
    return approval?.decision === "acceptForSession";
  }), false);
});

test("direct App Server client fails closed when child teardown or launch release cannot be proved", async () => {
  const work = workspace();
  const server = new FakeAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "thread/start") fake.send({ id: id(message), result: { thread: { id: "thread-2", ephemeral: true } } });
    else if (message.method === "turn/start") {
      fake.send({ id: id(message), result: { turn: { id: "turn-2", status: "inProgress" } } });
      queueMicrotask(() => fake.send({ method: "turn/completed", params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } } }));
    }
  }, false, false);

  const outcome = await new CodexAppServerExecutor({ launch: server.launch() }).execute(request(work));
  assert.deepEqual(outcome, { stopped: false, runId: "thread-2:turn-2", failure: "CODEX_APP_SERVER_RELEASE_UNCONFIRMED" });
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [false]);
});

test("direct App Server client interrupts and tears down an aborted turn", async () => {
  const work = workspace();
  const controller = new AbortController();
  let turnStarted = false;
  const server = new FakeAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "thread/start") fake.send({ id: id(message), result: { thread: { id: "thread-3", ephemeral: true } } });
    else if (message.method === "turn/start") {
      fake.send({ id: id(message), result: { turn: { id: "turn-3", status: "inProgress" } } });
      turnStarted = true;
      setImmediate(() => controller.abort(new Error("test abort")));
    }
  });

  const outcome = await new CodexAppServerExecutor({ launch: server.launch() }).execute(request(work, controller.signal));
  assert.deepEqual(outcome, { stopped: true, runId: "thread-3:turn-3", failure: "CANCELLED" });
  assert.equal(turnStarted, true);
  assert.equal(server.received.some(message => message.method === "turn/interrupt"), true);
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
});

test("direct App Server client rejects a non-ephemeral thread before it can start a turn", async () => {
  const work = workspace();
  const server = new FakeAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "thread/start") fake.send({ id: id(message), result: { thread: { id: "persistent-thread", ephemeral: false } } });
  });

  const outcome = await new CodexAppServerExecutor({ launch: server.launch() }).execute(request(work));
  assert.deepEqual(outcome, { stopped: true, failure: "CODEX_APP_SERVER_THREAD_INVALID" });
  assert.equal(server.received.some(message => message.method === "turn/start"), false);
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
});

test("direct App Server client cancels a handshake that does not respond", async () => {
  const work = workspace();
  const controller = new AbortController();
  const server = new FakeAppServer((message) => {
    if (message.method === "initialize") queueMicrotask(() => controller.abort(new Error("test startup abort")));
  });

  const outcome = await new CodexAppServerExecutor({ launch: server.launch() }).execute(request(work, controller.signal));
  assert.deepEqual(outcome, { stopped: true, failure: "CANCELLED" });
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
});

test("Seatbelt direct-client launch owns the canonical App Server spawn shape and releases failed setup", async () => {
  const work = workspace();
  const wrapper = "/private/tmp/fake/node_modules/@openai/codex/bin/codex.js";
  const spawned: unknown[] = [];
  const releases: boolean[] = [];
  const server = new FakeAppServer(() => {});
  const boundary = {
    id: "seatbelt-fixture",
    async prepare(seen: string) {
      assert.equal(seen, work);
      return { release: async (stopped: boolean) => { releases.push(stopped); return true; } };
    },
    spawn(spec: unknown) {
      spawned.push(spec);
      return {
        stdin: server.stdin,
        stdout: server.stdout,
        stderr: server.stderr,
        control: undefined,
        collected: {},
        done: server.done,
        terminate: () => server.finish(),
        waitForExit: async () => true,
      };
    },
  };
  const launch = new MacosSeatbeltAppServerClientLaunch({ boundary, wrapper, graceMs: 3000 });
  const prepared = await launch.prepare(work, new AbortController().signal);
  assert.equal(launch.id, "seatbelt-fixture:direct-client");
  assert.equal(prepared.child.stdin, server.stdin);
  assert.deepEqual(spawned, [{
    argv: [process.execPath, wrapper, "app-server", "--stdio"],
    cwd: work,
    env: {},
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    graceMs: 3000,
  }]);
  assert.equal(await prepared.release(true), true);
  assert.deepEqual(releases, [true]);

  const rejected = new MacosSeatbeltAppServerClientLaunch({
    boundary: {
      ...boundary,
      spawn() { throw new Error("fake spawn failure"); },
    },
    wrapper,
  });
  await assert.rejects(rejected.prepare(work, new AbortController().signal), /fake spawn failure/);
  assert.deepEqual(releases, [true, true]);

  const cancellationReleases: boolean[] = [];
  const controller = new AbortController();
  const cancelled = new MacosSeatbeltAppServerClientLaunch({
    boundary: {
      id: "seatbelt-cancelled-fixture",
      async prepare() {
        controller.abort(new Error("launch aborted after boundary preflight"));
        return { release: async (stopped: boolean) => { cancellationReleases.push(stopped); return true; } };
      },
      spawn() { assert.fail("an aborted launch must not spawn an App Server"); },
    },
    wrapper,
  });
  await assert.rejects(cancelled.prepare(work, controller.signal), /launch aborted after boundary preflight/);
  assert.deepEqual(cancellationReleases, [true]);
});

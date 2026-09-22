import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as codexProvider from "@deepseek-ai/dsh-subagent-codex";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { DshCandidateWorkspaceCodexExecutor, DshCodexExecutor, MacosSeatbeltAppServerConfinement } from "../../dist/src/index.js";

const capabilities = {
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
};

function request(signal = new AbortController().signal, workspace = os.tmpdir()) {
  return {
    task: {
      schemaVersion: 1,
      taskId: "codex-fixture-task",
      inputHash: "input-hash",
      policyHash: "policy-hash",
      status: "running",
      stage: "implement",
      retryCount: 0,
      readyForAcceptance: false,
      version: 1,
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
      input: {
        kind: "bugfix",
        title: "Normalize invalid pages",
        description: "Return 1 for invalid input; api_key=supersecret must not cross the provider boundary.",
        repositoryRef: "fixture",
        reproduction: { steps: ["Call normalizePage(0)"], expected: "1", actual: "0" },
        acceptanceCriteria: [{ id: "A1", description: "Invalid page values become 1." }],
        verificationProfile: "regression",
      },
    },
    workspace,
    snapshot: { id: "snapshot-1", baseCommit: "a".repeat(40), files: [], policyHash: "policy-hash", planHash: "plan-hash" },
    feedback: "Preserve frozen tests; token=secret-value must not cross the provider boundary.",
    signal,
    allowedPaths: ["src/"],
    protectedPaths: ["test/"],
  };
}

function parent(cwd = os.tmpdir()) {
  return { session: { id: "parent-session", header: { cwd } } };
}

async function withRegistry(start, action) {
  const ctx = new Context();
  const fiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await fiber;
  const release = ctx.subagents.registerProvider({
    name: "codex",
    capabilities,
    inheritsParentContext: false,
    start,
  });
  try {
    return await action(ctx.subagents);
  } finally {
    await release();
    await fiber.dispose();
  }
}

async function createAgentLoopHarness() {
  const ctx = new Context();
  const llmFiber = ctx.plugin(LlmRuntime);
  await llmFiber;
  const sessionsFiber = ctx.plugin(SessionStore);
  await sessionsFiber;
  const projectionsFiber = ctx.plugin(SessionProjectionRegistry);
  await projectionsFiber;
  const promptFiber = ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    personaPrefix: "Candidate Codex session fixture.",
    personaSuffix: "",
  });
  await promptFiber;
  const agentsFiber = ctx.plugin(AgentRegistry);
  await agentsFiber;
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const loopFiber = ctx.plugin(AgentLoop, { agents: [] });
  await loopFiber;
  const subagentsFiber = ctx.plugin(SubagentRuntime, { maxDepth: 2, maxActiveSubagents: 1 });
  await subagentsFiber;

  return {
    ctx,
    async dispose() {
      await subagentsFiber.dispose();
      await loopFiber.dispose();
      await toolsFiber.dispose();
      await agentsFiber.dispose();
      await promptFiber.dispose();
      await projectionsFiber.dispose();
      await sessionsFiber.dispose();
      await llmFiber.dispose();
    },
  };
}

/**
 * A local protocol peer for the official provider. It accepts the minimum
 * startup sequence, keeps the turn open, and only resolves its managed-range
 * outcome after the provider has asked it to terminate. No executable, model,
 * credential, or network transport is involved.
 */
function createBlockingCodexSubprocess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const turnStarted = Promise.withResolvers();
  let buffer = "";
  let exited = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const state = {
    spawnCwds: [],
    spawnSpecs: [],
    threadStart: undefined,
    interrupts: 0,
    terminateCalls: 0,
    waitForExitCalls: 0,
  };
  const send = (message) => { stdout.write(`${JSON.stringify(message)}\n`); };
  const respond = (id, result) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
  const receive = (frame) => {
    if (typeof frame?.method !== "string") return;
    switch (frame.method) {
      case "initialize":
        respond(frame.id, {});
        return;
      case "thread/start":
        state.threadStart = frame.params;
        respond(frame.id, { thread: { id: "fixture-thread", ephemeral: true } });
        return;
      case "turn/start":
        respond(frame.id, { turn: { id: "fixture-turn" } });
        queueMicrotask(() => {
          send({
            jsonrpc: "2.0",
            method: "turn/started",
            params: { threadId: "fixture-thread", turn: { id: "fixture-turn" } },
          });
          // The response above schedules the provider continuation that commits
          // the turn ID. Resolve on the next turn so cancellation exercises the
          // published-turn path instead of the legitimate startup race.
          setImmediate(() => turnStarted.resolve());
        });
        return;
      case "turn/interrupt":
        state.interrupts += 1;
        respond(frame.id, {});
        return;
      default:
        respond(frame.id, {});
    }
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) receive(JSON.parse(line));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  const terminate = () => {
    if (exited) return;
    exited = true;
    state.terminateCalls += 1;
    stdout.end();
    stderr.end();
    resolveDone({ exitCode: null, signal: "SIGTERM" });
  };
  return {
    state,
    turnStarted: turnStarted.promise,
    spawn(spec) {
      state.spawnCwds.push(spec.cwd);
      state.spawnSpecs.push(spec);
      return {
        stdin,
        stdout,
        stderr,
        control: undefined,
        collected: {},
        done,
        terminate,
        async waitForExit() {
          state.waitForExitCalls += 1;
          return exited;
        },
      };
    },
  };
}

test("DshCodexExecutor uses the real DSH subagent registry with a bounded self-contained prompt", async () => {
  let observed;
  let disposed = 0;
  await withRegistry(async (startRequest) => {
    observed = startRequest;
    return {
      id: "codex-run-1",
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: "text", text: "implemented" }], stopReason: "completed" }),
      dispose: async () => { disposed += 1; },
    };
  }, async (subagents) => {
    const parentAgent = parent();
    const executor = new DshCodexExecutor({ subagents, parent: parentAgent });
    const result = await executor.execute(request());
    assert.deepEqual(result, { stopped: true, runId: "codex-run-1" });
    assert.equal(observed.parent, parentAgent);
    assert.equal(observed.label, "devkit:codex-fixture-task");
    assert.equal(observed.agentOptions, undefined);
    assert.equal(observed.outputSchema, undefined);
    assert.equal(observed.maxDepth, undefined);
    assert.equal(observed.toolFilter, undefined);
    assert.equal(observed.persona, undefined);
    assert.equal(observed.prompt.length, 1);
    assert.equal(observed.prompt[0].type, "text");
    assert.match(observed.prompt[0].text, /Allowed write paths:\n- src\//);
    assert.match(observed.prompt[0].text, /Protected paths:\n- test\//);
    assert.doesNotMatch(observed.prompt[0].text, /supersecret|secret-value/);
    assert.match(observed.prompt[0].text, /\[REDACTED\]/);
  });
  assert.equal(disposed, 1);
});

test("DshCodexExecutor fails closed without a Codex provider and preserves stopped state for provider failures", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await fiber;
  try {
    const unavailable = new DshCodexExecutor({ subagents: ctx.subagents, parent: parent() });
    assert.deepEqual(await unavailable.execute(request()), { stopped: true, failure: "CODEX_PROVIDER_UNAVAILABLE" });
  } finally {
    await fiber.dispose();
  }

  let disposed = 0;
  await withRegistry(async () => ({
    id: "codex-run-2",
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "safe provider detail" }),
    dispose: async () => { disposed += 1; },
  }), async (subagents) => {
    const executor = new DshCodexExecutor({ subagents, parent: parent() });
    assert.deepEqual(await executor.execute(request()), {
      stopped: true,
      runId: "codex-run-2",
      failure: "CODEX_SUBAGENT_ERROR",
    });
  });
  assert.equal(disposed, 1);
});

test("DshCodexExecutor maps an unconfirmed disposal to a retained-writer result", async () => {
  await withRegistry(async () => ({
    id: "codex-run-3",
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: "completed" }),
    dispose: async () => { throw new Error("cannot prove child exit"); },
  }), async (subagents) => {
    const executor = new DshCodexExecutor({ subagents, parent: parent() });
    assert.deepEqual(await executor.execute(request()), {
      stopped: false,
      runId: "codex-run-3",
      failure: "CODEX_SUBAGENT_DISPOSAL_UNCONFIRMED",
    });
  });
});

test("DshCodexExecutor rejects a parent session not bound to the candidate workspace", async () => {
  let starts = 0;
  await withRegistry(async () => {
    starts += 1;
    throw new Error("a mismatched workspace must never start the provider");
  }, async (subagents) => {
    const executor = new DshCodexExecutor({
      subagents,
      parent: parent(path.join(os.tmpdir(), "dsh-devkit-not-the-candidate")),
    });
    assert.deepEqual(await executor.execute(request()), {
      stopped: true,
      failure: "CODEX_WORKSPACE_BINDING_UNAVAILABLE",
    });
  });
  assert.equal(starts, 0);
});

test("DshCandidateWorkspaceCodexExecutor preflights a host App Server boundary and retains failure when it cannot release", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-boundary-candidate-"));
  const events = [];
  const executor = new DshCandidateWorkspaceCodexExecutor({
    agents: {
      async create(options) {
        events.push(`parent:${options.meta.cwd}`);
        return { agent: parent(workspace), async dispose() { events.push("parent-dispose"); } };
      },
    },
    subagents: {
      getProvider() { return {}; },
      async start() {
        events.push("provider-start");
        return {
          id: "boundary-run",
          result: Promise.resolve({ output: [], stopReason: "completed" }),
          async dispose() { events.push("provider-dispose"); },
        };
      },
    },
    parent: parent(),
    appServerBoundary: {
      async prepare(preparedWorkspace) {
        events.push(`prepare:${preparedWorkspace}`);
        return {
          async release(stopped) {
            events.push(`release:${stopped}`);
            return false;
          },
        };
      },
    },
  });

  const result = await executor.execute(request(new AbortController().signal, workspace));
  assert.deepEqual(result, { stopped: false, runId: "boundary-run", failure: "CODEX_APP_SERVER_BOUNDARY_RELEASE_UNCONFIRMED" });
  assert.deepEqual(events, [
    `prepare:${workspace}`,
    `parent:${realpathSync(workspace)}`,
    "provider-start",
    "provider-dispose",
    "parent-dispose",
    "release:true",
  ]);
});

test("DshCandidateWorkspaceCodexExecutor does not create a parent when host App Server preflight fails", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-boundary-unavailable-"));
  let parentCreates = 0;
  const executor = new DshCandidateWorkspaceCodexExecutor({
    agents: { async create() { parentCreates += 1; throw new Error("must not run"); } },
    subagents: { getProvider() { return {}; }, async start() { throw new Error("must not run"); } },
    parent: parent(),
    appServerBoundary: { async prepare() { throw new Error("host sandbox unavailable"); } },
  });

  assert.deepEqual(await executor.execute(request(new AbortController().signal, workspace)), {
    stopped: true, failure: "CODEX_APP_SERVER_BOUNDARY_UNAVAILABLE",
  });
  assert.equal(parentCreates, 0);
});

test("DshCandidateWorkspaceCodexExecutor composes a real candidate-bound DSH parent session and releases it", { timeout: 10000 }, async () => {
  const sourceWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-source-parent-"));
  const candidateWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-candidate-parent-"));
  const harness = await createAgentLoopHarness();
  let source;
  let release;
  let candidateSessionId;
  let observed;
  let disposed = 0;

  try {
    source = await harness.ctx.agents.create({
      sessionId: "dsh-devkit-source-parent-session",
      meta: { cwd: sourceWorkspace },
    });
    release = harness.ctx.subagents.registerProvider({
      name: "codex",
      capabilities,
      inheritsParentContext: false,
      async start(startRequest) {
        observed = startRequest;
        return {
          id: "candidate-codex-run",
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: "text", text: "fixture complete" }], stopReason: "completed" }),
          dispose: async () => { disposed += 1; },
        };
      },
    });
    const agents = {
      create(options) {
        candidateSessionId = options.sessionId;
        assert.equal(options.parentAgent, source.agent);
        assert.deepEqual(options.meta, {
          cwd: realpathSync(candidateWorkspace),
          parentSession: source.agent.session.id,
          origin: "subagent",
          delegationDepth: 1,
        });
        return harness.ctx.agents.create(options);
      },
    };
    const executor = new DshCandidateWorkspaceCodexExecutor({
      agents,
      subagents: harness.ctx.subagents,
      parent: source.agent,
    });

    assert.deepEqual(await executor.execute(request(new AbortController().signal, candidateWorkspace)), {
      stopped: true,
      runId: "candidate-codex-run",
    });
    assert.ok(observed, "the fixture provider must receive the candidate parent");
    assert.notEqual(observed.parent, source.agent);
    assert.equal(observed.parent.session.header.cwd, realpathSync(candidateWorkspace));
    assert.equal(observed.parent.session.header.parentSession, source.agent.session.id);
    assert.equal(observed.parent.session.header.origin, "subagent");
    assert.equal(observed.parent.session.header.delegationDepth, 1);
    assert.equal(disposed, 1);
    assert.equal(harness.ctx.agents.get(candidateSessionId), undefined, "the short-lived candidate parent is released after the Codex child settles");
    assert.equal(harness.ctx.sessions.get(candidateSessionId), undefined, "the candidate Session is removed with its owned Agent handle");
  } finally {
    await release?.();
    await source?.dispose();
    await harness.dispose();
  }
});

test("DshCandidateWorkspaceCodexExecutor sends the real official provider only the candidate cwd at its subprocess seam", { timeout: 10000 }, async () => {
  const sourceWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-official-source-"));
  const candidateWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-official-candidate-"));
  const harness = await createAgentLoopHarness();
  let source;
  let providerFiber;
  let disposeSubprocess;
  let candidateSessionId;
  const spawnCwds = [];

  try {
    disposeSubprocess = harness.ctx.provide("subprocess", {
      spawn(spec) {
        spawnCwds.push(spec.cwd);
        throw new Error("fixture subprocess seam refuses to start Codex");
      },
    });
    providerFiber = harness.ctx.plugin(codexProvider, {
      providerName: "codex",
      env: {},
      permissionMode: "never",
      disposeGraceMs: 3000,
    });
    await providerFiber;
    source = await harness.ctx.agents.create({
      sessionId: "dsh-devkit-official-source-session",
      meta: { cwd: sourceWorkspace },
    });
    const agents = {
      create(options) {
        candidateSessionId = options.sessionId;
        return harness.ctx.agents.create(options);
      },
    };
    const executor = new DshCandidateWorkspaceCodexExecutor({
      agents,
      subagents: harness.ctx.subagents,
      parent: source.agent,
    });

    assert.deepEqual(await executor.execute(request(new AbortController().signal, candidateWorkspace)), {
      stopped: true,
      failure: "CODEX_SUBAGENT_START_FAILED",
    });
    assert.deepEqual(spawnCwds, [realpathSync(candidateWorkspace)]);
    assert.equal(harness.ctx.agents.get(candidateSessionId), undefined, "the failed official-provider start still releases the candidate parent");
  } finally {
    await source?.dispose();
    await providerFiber?.dispose();
    await disposeSubprocess?.();
    await harness.dispose();
  }
});

test("DshCandidateWorkspaceCodexExecutor fails closed when its candidate parent cannot be created or released", async () => {
  let starts = 0;
  let childDisposals = 0;
  await withRegistry(async () => {
    starts += 1;
    return {
      id: "candidate-disposal-run",
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: "completed" }),
      dispose: async () => { childDisposals += 1; },
    };
  }, async (subagents) => {
    const creationFailure = new DshCandidateWorkspaceCodexExecutor({
      subagents,
      parent: parent(),
      agents: {
        async create() {
          throw new Error("candidate session factory unavailable");
        },
      },
    });
    assert.deepEqual(await creationFailure.execute(request()), {
      stopped: true,
      failure: "CODEX_PARENT_SESSION_START_FAILED",
    });
    assert.equal(starts, 0, "a failed candidate-parent composition must not publish a Codex child");

    const disposalFailure = new DshCandidateWorkspaceCodexExecutor({
      subagents,
      parent: parent(),
      agents: {
        async create() {
          return {
            agent: parent(),
            async dispose() {
              throw new Error("candidate parent teardown cannot be proved");
            },
          };
        },
      },
    });
    assert.deepEqual(await disposalFailure.execute(request()), {
      stopped: false,
      runId: "candidate-disposal-run",
      failure: "CODEX_PARENT_SESSION_DISPOSAL_UNCONFIRMED",
    });
  });
  assert.equal(starts, 1);
  assert.equal(childDisposals, 1, "the published Codex child still receives its own disposal attempt");
});

test("DshCandidateWorkspaceCodexExecutor propagates cancellation through the official workspace-write provider and proves child teardown", { timeout: 10000 }, async () => {
  const sourceWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-cancel-source-"));
  const candidateWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-cancel-candidate-"));
  const harness = await createAgentLoopHarness();
  const controller = new AbortController();
  const subprocess = createBlockingCodexSubprocess();
  let source;
  let providerFiber;
  let disposeSubprocess;
  let candidateSessionId;

  try {
    disposeSubprocess = harness.ctx.provide("subprocess", {
      spawn(spec) { return subprocess.spawn(spec); },
    });
    providerFiber = harness.ctx.plugin(codexProvider, {
      providerName: "codex",
      env: {},
      permissionMode: "approve-for-me",
      disposeGraceMs: 3000,
    });
    await providerFiber;
    source = await harness.ctx.agents.create({
      sessionId: "dsh-devkit-cancel-source-session",
      meta: { cwd: sourceWorkspace },
    });
    const executor = new DshCandidateWorkspaceCodexExecutor({
      agents: {
        create(options) {
          candidateSessionId = options.sessionId;
          return harness.ctx.agents.create(options);
        },
      },
      subagents: harness.ctx.subagents,
      parent: source.agent,
    });

    const pending = executor.execute(request(controller.signal, candidateWorkspace));
    await subprocess.turnStarted;
    controller.abort(new Error("fixture cancellation"));
    const result = await pending;

    assert.equal(result.stopped, true);
    assert.equal(typeof result.runId, "string");
    assert.equal(result.failure, "CODEX_SUBAGENT_ABORTED");
    assert.deepEqual(subprocess.state.spawnCwds, [realpathSync(candidateWorkspace)]);
    assert.deepEqual(subprocess.state.threadStart, {
      cwd: realpathSync(candidateWorkspace),
      ephemeral: true,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
    assert.equal(subprocess.state.interrupts, 1, "the provider sends one best-effort turn interruption");
    assert.equal(subprocess.state.terminateCalls, 1, "the provider owns the managed child termination");
    assert.ok(subprocess.state.waitForExitCalls >= 1, "the provider awaits managed-range quiescence");
    assert.equal(harness.ctx.agents.get(candidateSessionId), undefined, "the candidate parent is released only after the child settles");
    assert.equal(harness.ctx.sessions.get(candidateSessionId), undefined, "the candidate session is removed after confirmed teardown");
  } finally {
    await source?.dispose();
    await providerFiber?.dispose();
    await disposeSubprocess?.();
    await harness.dispose();
  }
});

test("candidate cancellation traverses the prepared Seatbelt App Server boundary before the official provider", { timeout: 10000 }, async () => {
  const sourceWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-boundary-source-"));
  const candidateWorkspace = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-boundary-candidate-"));
  const protectedRoot = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-boundary-protected-"));
  const harness = await createAgentLoopHarness();
  const controller = new AbortController();
  const rawSubprocess = createBlockingCodexSubprocess();
  const boundary = new MacosSeatbeltAppServerConfinement({
    subprocess: { spawn(spec) { return rawSubprocess.spawn(spec); } },
    deniedReadRoots: [protectedRoot],
    sandboxExec: path.join(protectedRoot, "sandbox-exec"),
    status: async () => ({
      state: "supported", mechanism: "macos-seatbelt", platform: "darwin", enforcement: "full", filesystem: "full", network: "full", credentialReads: "configured-roots",
      probe: { workspaceWriteAllowed: true, controlWriteDenied: true, protectedReadDenied: true, networkDenied: true, unixSocketDenied: true },
    }),
  });
  let source;
  let providerFiber;
  let disposeScopedSubprocess;
  let candidateSessionId;

  try {
    const scoped = harness.ctx.root.isolate("subprocess");
    disposeScopedSubprocess = scoped.provide("subprocess", boundary);
    providerFiber = scoped.plugin(codexProvider, {
      providerName: "codex", env: {}, permissionMode: "approve-for-me", disposeGraceMs: 3000,
    });
    await providerFiber;
    source = await harness.ctx.agents.create({
      sessionId: "dsh-devkit-boundary-source-session",
      meta: { cwd: sourceWorkspace },
    });
    const executor = new DshCandidateWorkspaceCodexExecutor({
      agents: { create(options) { candidateSessionId = options.sessionId; return harness.ctx.agents.create(options); } },
      subagents: harness.ctx.subagents,
      parent: source.agent,
      appServerBoundary: boundary,
    });

    const pending = executor.execute(request(controller.signal, candidateWorkspace));
    await rawSubprocess.turnStarted;
    controller.abort(new Error("fixture cancellation through prepared boundary"));
    const result = await pending;

    assert.equal(result.stopped, true);
    assert.equal(result.failure, "CODEX_SUBAGENT_ABORTED");
    assert.equal(rawSubprocess.state.spawnSpecs.length, 1);
    const wrapped = rawSubprocess.state.spawnSpecs[0];
    assert.equal(wrapped.argv[0], path.join(protectedRoot, "sandbox-exec"));
    assert.match(wrapped.argv[2], /\(deny network\*\)/);
    assert.equal(wrapped.env.CODEX_HOME, undefined);
    assert.equal(typeof wrapped.env.TMPDIR, "string");
    assert.equal(existsSync(wrapped.env.TMPDIR), false, "the boundary removes its private root only after provider range proof");
    assert.equal(rawSubprocess.state.interrupts, 1);
    assert.equal(rawSubprocess.state.terminateCalls, 1);
    assert.ok(rawSubprocess.state.waitForExitCalls >= 1);
    assert.equal(harness.ctx.agents.get(candidateSessionId), undefined);
  } finally {
    await source?.dispose();
    await providerFiber?.dispose();
    await disposeScopedSubprocess?.();
    await harness.dispose();
  }
});

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { DshCodexExecutor } from "../../dist/src/index.js";

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

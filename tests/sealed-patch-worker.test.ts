import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  Devkit,
  SealedPatchProposalExecutor,
  exportPatch,
  prepareWorkspace,
  resolveBase,
  snapshot,
  type ExecutionRequest,
  type SealedPatchWorker,
  type SealedPatchWorkerRequest,
} from "../src/index.js";
import { adapters, broken, fixture, fixed, input } from "./helpers.js";

function requestFor(f: ReturnType<typeof fixture>, signal: AbortSignal = new AbortController().signal): { readonly runtime: Devkit; readonly request: ExecutionRequest; readonly base: string } {
  const runtime = new Devkit(f.policy, adapters());
  const task = runtime.create(input);
  const base = resolveBase(f.repo);
  const workspace = prepareWorkspace(f.repo, path.join(f.root, "sealed-targets"), task.taskId, base, randomUUID());
  const before = snapshot(workspace, base, "sealed-policy", "sealed-plan");
  return {
    runtime,
    base,
    request: {
      task,
      workspace,
      snapshot: before,
      feedback: "Required verification failed; preserve the frozen tests.",
      signal,
      allowedPaths: ["src/"],
      protectedPaths: ["test/"],
    },
  };
}

function proposalPatch(f: ReturnType<typeof fixture>, base: string, changedPath: string, content: string): string {
  const workspace = prepareWorkspace(f.repo, path.join(f.root, "sealed-proposals"), "proposal", base, randomUUID());
  writeFileSync(path.join(workspace, changedPath), content, "utf8");
  return exportPatch(workspace, base, [changedPath.includes("/") ? `${changedPath.slice(0, changedPath.indexOf("/") + 1)}` : changedPath]);
}

function completedWorker(onRequest: (request: SealedPatchWorkerRequest) => string): SealedPatchWorker {
  return {
    id: "synthetic-sealed-worker",
    begin(request) {
      return {
        id: "synthetic-operation",
        result: Promise.resolve({ state: "completed", proposal: { snapshotId: request.snapshot.id, patch: onRequest(request) } }),
        stop: async () => true,
      };
    },
  };
}

test("sealed patch worker receives a frozen by-value source snapshot and applies only its matching proposal", async () => {
  const f = fixture();
  const { runtime, request, base } = requestFor(f);
  try {
    const patch = proposalPatch(f, base, "src/page.mjs", fixed);
    let observed: SealedPatchWorkerRequest | undefined;
    const executor = new SealedPatchProposalExecutor(completedWorker(message => {
      observed = message;
      return patch;
    }));
    const result = await executor.execute(request);
    assert.deepEqual(result, { stopped: true, runId: "synthetic-sealed-worker" });
    assert.equal(readFileSync(path.join(request.workspace, "src/page.mjs"), "utf8"), fixed);
    assert.ok(observed);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed.source), true);
    assert.equal(Object.hasOwn(observed, "workspace"), false);
    assert.equal(Object.hasOwn(observed.task, "repositoryRef"), false);
    assert.equal(JSON.stringify(observed).includes(request.workspace), false);
    assert.equal(JSON.stringify(observed).includes(f.data), false);
    assert.equal(observed.source.find(file => file.path === "src/page.mjs")?.content, broken);
    assert.equal(observed.snapshot.id, request.snapshot.id);
  } finally {
    await runtime.close();
  }
});

test("sealed patch worker rejects stale and protected proposals before candidate mutation", async () => {
  const staleFixture = fixture();
  const stale = requestFor(staleFixture);
  try {
    const executor = new SealedPatchProposalExecutor({
      id: "synthetic-stale-worker",
      begin(message) {
        return {
          id: "synthetic-stale-operation",
          result: Promise.resolve({ state: "completed", proposal: { snapshotId: "0".repeat(64), patch: "" } }),
          stop: async () => true,
        };
      },
    });
    assert.deepEqual(await executor.execute(stale.request), { stopped: true, failure: "SEALED_PATCH_PROPOSAL_STALE" });
    assert.equal(readFileSync(path.join(stale.request.workspace, "src/page.mjs"), "utf8"), broken);
  } finally {
    await stale.runtime.close();
  }

  const protectedFixture = fixture();
  const protectedRequest = requestFor(protectedFixture);
  try {
    const original = readFileSync(path.join(protectedRequest.request.workspace, "test/page.test.mjs"), "utf8");
    const patch = proposalPatch(protectedFixture, protectedRequest.base, "test/page.test.mjs", `${original}\n// forbidden\n`);
    const executor = new SealedPatchProposalExecutor(completedWorker(() => patch));
    assert.deepEqual(await executor.execute(protectedRequest.request), { stopped: true, failure: "SEALED_PATCH_PATH_REJECTED" });
    assert.equal(readFileSync(path.join(protectedRequest.request.workspace, "test/page.test.mjs"), "utf8"), original);
  } finally {
    await protectedRequest.runtime.close();
  }
});

test("sealed patch worker cancellation requires its own stop proof", async () => {
  const f = fixture();
  const controller = new AbortController();
  const { runtime, request } = requestFor(f, controller.signal);
  let resolveResult: ((value: unknown) => void) | undefined;
  let stops = 0;
  const executor = new SealedPatchProposalExecutor({
    id: "synthetic-cancellable-worker",
    begin() {
      return {
        id: "synthetic-cancellable-operation",
        result: new Promise(resolve => { resolveResult = resolve; }),
        stop: async () => { stops += 1; return true; },
      };
    },
  });
  try {
    const running = executor.execute(request);
    controller.abort();
    assert.deepEqual(await running, { stopped: true, failure: "CANCELLED" });
    assert.equal(stops, 1);
    assert.equal(readFileSync(path.join(request.workspace, "src/page.mjs"), "utf8"), broken);
  } finally {
    resolveResult?.({ state: "failed" });
    await runtime.close();
  }
});

test("sealed patch worker retains the lease when startup cannot yield a stoppable operation", async () => {
  const f = fixture();
  const { runtime, request } = requestFor(f);
  try {
    const executor = new SealedPatchProposalExecutor({
      id: "synthetic-broken-worker",
      begin() { throw new Error("unproven remote start"); },
    });
    assert.deepEqual(await executor.execute(request), { stopped: false });
    assert.equal(readFileSync(path.join(request.workspace, "src/page.mjs"), "utf8"), broken);
  } finally {
    await runtime.close();
  }
});

test("sealed patch worker blocks secret-looking source before it can start an operation", async () => {
  const f = fixture();
  const { runtime, request } = requestFor(f);
  let started = false;
  try {
    writeFileSync(path.join(request.workspace, "src/page.mjs"), "export const api_key = 'unsafe-value';\n", "utf8");
    const changed = snapshot(request.workspace, request.snapshot.baseCommit, request.snapshot.policyHash, request.snapshot.planHash);
    const executor = new SealedPatchProposalExecutor({
      id: "synthetic-secret-worker",
      begin() {
        started = true;
        throw new Error("must not start");
      },
    });
    assert.deepEqual(await executor.execute({ ...request, snapshot: changed }), { stopped: true, failure: "POSSIBLE_SECRET_IN_SEALED_WORKER_SOURCE" });
    assert.equal(started, false);
  } finally {
    await runtime.close();
  }
});

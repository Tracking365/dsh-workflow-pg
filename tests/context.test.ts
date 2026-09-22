import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPaginationFixturePolicy, byteHash, Devkit, dshCodexPrompt, git, validateTaskInput, type ExecutionRequest, type HostPolicy } from "../src/index.js";
import { adapters, fixture, fixed, input } from "./helpers.js";

function commit(repository: string, message: string, files: readonly string[]): void {
  git(repository, ["add", "--", ...files]);
  git(repository, ["-c", "user.name=DevKit Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message]);
}

function contextPolicy(f: ReturnType<typeof fixture>): HostPolicy {
  return {
    ...f.policy,
    repositories: {
      fixture: { ...f.policy.repositories.fixture!, contextPaths: ["docs/"] },
    },
  };
}

test("context references are canonical, host-authorized, and excluded from the native fixture", async () => {
  assert.deepEqual(validateTaskInput({ ...input, contextRefs: ["docs/z.md", "docs/a.md"] }).contextRefs, ["docs/a.md", "docs/z.md"]);
  for (const contextRefs of [["../secret"], ["docs/"], ["docs/a.md", "docs/a.md"], ["docs/with\nnewline.md"]]) {
    assert.throws(() => validateTaskInput({ ...input, contextRefs }), /CONTEXT_REFERENCE|DUPLICATE_CONTEXT_REFERENCE/);
  }

  const f = fixture();
  mkdirSync(path.join(f.repo, "docs"));
  writeFileSync(path.join(f.repo, "docs", "contract.md"), "The source policy is host-owned.\n");
  commit(f.repo, "add context", ["docs/contract.md"]);
  const policy = contextPolicy(f);
  assert.throws(() => assertPaginationFixturePolicy(policy), /FIXTURE_REPOSITORY_POLICY_INVALID/);

  const withoutReadPolicy = new Devkit(f.policy, adapters());
  try {
    assert.throws(() => withoutReadPolicy.create({ ...input, contextRefs: ["docs/contract.md"] }), /CONTEXT_REFERENCE_NOT_AUTHORIZED/);
  } finally {
    await withoutReadPolicy.close();
  }
});

test("context is frozen at the Git base, supplied to the executor, and never stored in task metadata", async () => {
  const f = fixture();
  const original = "The historical contract requires invalid page numbers to become one.\n";
  mkdirSync(path.join(f.repo, "docs"));
  writeFileSync(path.join(f.repo, "docs", "contract.md"), original);
  commit(f.repo, "add frozen context", ["docs/contract.md"]);

  let observed: ExecutionRequest | undefined;
  let prompt = "";
  const runtime = new Devkit(contextPolicy(f), adapters({
    execute: async (request) => {
      observed = request;
      const block = dshCodexPrompt(request)[0];
      if (!block || block.type !== "text") throw new Error("missing Codex prompt text");
      prompt = block.text;
      writeFileSync(path.join(request.workspace, "src", "page.mjs"), fixed);
      return { stopped: true, runId: "context-fixture" };
    },
  }));
  try {
    const task = runtime.create({ ...input, baseRef: "HEAD", contextRefs: ["docs/contract.md"] });
    const frozen = task.frozenContext;
    assert.ok(frozen);
    assert.deepEqual(frozen.files, [{ path: "docs/contract.md", hash: byteHash(original), size: Buffer.byteLength(original) }]);
    assert.equal(JSON.stringify(task).includes(original), false);
    const artifact = path.join(f.data, "contexts", `${frozen.manifestHash}.json`);
    assert.equal(existsSync(artifact), true);
    assert.equal(statSync(path.join(f.data, "contexts")).mode & 0o777, 0o700);
    assert.equal(statSync(artifact).mode & 0o777, 0o600);
    assert.equal((JSON.parse(readFileSync(artifact, "utf8")) as { files: Array<{ content: string }> }).files[0]?.content, original);

    writeFileSync(path.join(f.repo, "docs", "contract.md"), "The current source repository now says something else.\n");
    commit(f.repo, "change source context after task creation", ["docs/contract.md"]);

    const result = await runtime.run(task.taskId);
    assert.equal(result.status, "awaiting_human");
    assert.equal(result.reason, "final_acceptance");
    assert.equal(observed?.context?.manifest.baseCommit, task.baseCommit);
    assert.equal(observed?.context?.files[0]?.content, original);
    assert.match(prompt, /Frozen host-authorized context/);
    assert.match(prompt, /historical contract requires invalid page numbers/);
    assert.match(prompt, new RegExp(frozen.manifestHash));
    const loaded = runtime.store.history(task.taskId).find((event) => event.type === "context_loaded");
    assert.ok(loaded);
    assert.equal(JSON.stringify(loaded.payload).includes(original), false);
    assert.deepEqual((loaded.payload as { files: unknown }).files, frozen.files);
  } finally {
    await runtime.close();
  }
});

test("secret-looking or corrupt frozen context blocks before the executor receives a workspace", async () => {
  const secretFixture = fixture();
  mkdirSync(path.join(secretFixture.repo, "docs"));
  writeFileSync(path.join(secretFixture.repo, "docs", "contract.md"), "api_key=must-not-be-context\n");
  commit(secretFixture.repo, "add unsafe context", ["docs/contract.md"]);
  const secretRuntime = new Devkit(contextPolicy(secretFixture), adapters());
  try {
    assert.throws(() => secretRuntime.create({ ...input, contextRefs: ["docs/contract.md"] }), /POSSIBLE_SECRET_IN_CONTEXT/);
  } finally {
    await secretRuntime.close();
  }

  const f = fixture();
  mkdirSync(path.join(f.repo, "docs"));
  writeFileSync(path.join(f.repo, "docs", "contract.md"), "A safe immutable context file.\n");
  commit(f.repo, "add safe context", ["docs/contract.md"]);
  let executions = 0;
  const runtime = new Devkit(contextPolicy(f), adapters({
    execute: async () => {
      executions += 1;
      return { stopped: true, runId: "should-not-run" };
    },
  }));
  try {
    const task = runtime.create({ ...input, contextRefs: ["docs/contract.md"] });
    const frozen = task.frozenContext;
    assert.ok(frozen);
    writeFileSync(path.join(f.data, "contexts", `${frozen.manifestHash}.json`), "not json");
    const result = await runtime.run(task.taskId);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "CONTEXT_ARTIFACT_CORRUPT");
    assert.equal(executions, 0);
    assert.equal(runtime.store.history(task.taskId).some((event) => event.type === "executor_dispatch"), false);
  } finally {
    await runtime.close();
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as codexProvider from "@deepseek-ai/dsh-subagent-codex";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { PAGINATION_BROKEN_SOURCE, PAGINATION_FIXTURE_DRIVER, PAGINATION_FIXTURE_MARKER, PAGINATION_TEST_SOURCE } from "../../dist/src/index.js";
import * as native from "../../native/index.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepository(root) {
  const repository = path.join(root, "repository");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, PAGINATION_FIXTURE_MARKER), `${JSON.stringify({ schemaVersion: 1, driver: PAGINATION_FIXTURE_DRIVER })}\n`);
  writeFileSync(path.join(repository, "src", "page.mjs"), PAGINATION_BROKEN_SOURCE);
  writeFileSync(path.join(repository, "test", "page.test.mjs"), PAGINATION_TEST_SOURCE);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["add", "."]);
  git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  return repository;
}

function call(tools, name, arguments_, sequence) {
  return tools.execute({
    callId: `native-fixture-${sequence}`,
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  });
}

test("real Cordis ToolRuntime registers, dispatches, unloads, and reloads DevKit tools", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-native-"));
  const repository = createRepository(root);
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "disabled",
    repositories: {
      fixture: { path: repository, allowedPaths: ["src/"], protectedPaths: ["test/"] },
    },
    verificationProfiles: {
      regression: [{ id: "regression", command: process.execPath, args: ["--test", "test/page.test.mjs"], criteria: ["A1"], timeoutMs: 5000 }],
    },
    maxRetries: 2,
    maxDurationMs: 10000,
  }));

  const ctx = new Context();
  // ToolRuntime requires the real DSH systemPrompt service. This deliberately
  // narrow test double is only a prompt-registration sink; dispatch itself is
  // the published Cordis + dsh-tools implementation.
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  let mounted = ctx.plugin(plugin, { configPath });

  try {
    await mounted;
    assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name).sort(), [
      "dev_task_cancel", "dev_task_create", "dev_task_report", "dev_task_resume", "dev_task_run", "dev_task_status", "devkit_doctor",
    ]);

    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.equal(doctor.value.executionMode, "disabled");
    assert.equal(doctor.value.nativeRuntime.state, "supported");
    assert.equal(doctor.value.codexSubagent.reason, "DSH_SUBAGENT_SERVICE_MISSING");

    const created = await call(ctx.tools, "dev_task_create", {
      kind: "bugfix",
      title: "Native registry fixture",
      description: "Exercise actual ToolRuntime dispatch.",
      repositoryRef: "fixture",
      reproduction: { steps: ["run regression"], expected: "fail", actual: "fail" },
      acceptanceCriteria: [{ id: "A1", description: "fixture is callable" }],
      verificationProfile: "regression",
    }, 2);
    assert.equal(created.isError, false);
    assert.equal(typeof created.value.taskId, "string");

    const status = await call(ctx.tools, "dev_task_status", { taskId: created.value.taskId }, 3);
    assert.equal(status.isError, false);
    assert.equal(status.value.status, "queued");

    const invalid = await call(ctx.tools, "dev_task_status", { taskId: created.value.taskId, unexpected: true }, 4);
    assert.equal(invalid.isError, true);

    const blockedRun = await call(ctx.tools, "dev_task_run", { taskId: created.value.taskId }, 5);
    assert.equal(blockedRun.isError, false);
    assert.equal(blockedRun.value.reason, "LIVE_SANDBOX_NOT_IMPLEMENTED");

    await mounted.dispose();
    assert.equal(ctx.tools.get("devkit_doctor"), undefined);

    mounted = ctx.plugin(plugin, { configPath });
    await mounted;
    assert.ok(ctx.tools.get("devkit_doctor"));
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await disposePrompt();
  }
});

test("explicit native fixture policy completes a deterministic task lifecycle without a model", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-native-pagination-"));
  const repository = createRepository(root);
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "fixture",
    fixtureDriver: PAGINATION_FIXTURE_DRIVER,
    repositories: {
      fixture: { path: repository, allowedPaths: ["src/"], protectedPaths: ["test/"] },
    },
    verificationProfiles: {
      regression: [{ id: "regression", command: process.execPath, args: ["--test", "--test-reporter=tap", "test/page.test.mjs"], criteria: ["A1"], timeoutMs: 5000 }],
    },
    maxRetries: 2,
    maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath, fixtureDriver: PAGINATION_FIXTURE_DRIVER });

  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.equal(doctor.value.executionMode, "fixture");
    assert.deepEqual(doctor.value.fixture, { state: "enabled", driver: PAGINATION_FIXTURE_DRIVER, deterministic: true, nonProduction: true });
    assert.equal(doctor.value.nativeRuntime.fixtureMode, PAGINATION_FIXTURE_DRIVER);

    const created = await call(ctx.tools, "dev_task_create", {
      kind: "bugfix",
      title: "Native deterministic pagination fixture",
      description: "Run the bounded fixture through the real ToolRuntime.",
      repositoryRef: "fixture",
      reproduction: { steps: ["Pass zero to normalizePage"], expected: "1", actual: "0" },
      acceptanceCriteria: [{ id: "A1", description: "Invalid pages normalize to 1 and positive integers are preserved" }],
      verificationProfile: "regression",
    }, 2);
    assert.equal(created.isError, false);

    const run = await call(ctx.tools, "dev_task_run", { taskId: created.value.taskId }, 3);
    assert.equal(run.isError, false);
    assert.equal(run.value.status, "awaiting_human");
    assert.equal(run.value.readyForAcceptance, true);

    const status = await call(ctx.tools, "dev_task_status", { taskId: created.value.taskId }, 4);
    assert.equal(status.isError, false);
    assert.equal(status.value.snapshotId, run.value.snapshotId);

    const report = await call(ctx.tools, "dev_task_report", { taskId: created.value.taskId }, 5);
    assert.equal(report.isError, false);
    assert.equal(report.value.evidenceMode, "fixture");
    assert.ok(report.value.events.some((event) => event.type === "workspace_guarded"));
    assert.ok(report.value.events.some((event) => event.type === "executor_settled" && event.payload.runId === PAGINATION_FIXTURE_DRIVER));
    assert.ok(report.value.events.some((event) => event.type === "ready_for_acceptance"));

    const resume = await call(ctx.tools, "dev_task_resume", { taskId: created.value.taskId }, 6);
    assert.equal(resume.isError, true);

    const cancelled = await call(ctx.tools, "dev_task_cancel", { taskId: created.value.taskId }, 7);
    assert.equal(cancelled.isError, false);
    assert.equal(cancelled.value.status, "cancelled");
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await disposePrompt();
  }
});

test("a fixture policy alone cannot enable the native deterministic adapter", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-native-fixture-gate-"));
  const repository = createRepository(root);
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "fixture",
    fixtureDriver: PAGINATION_FIXTURE_DRIVER,
    repositories: { fixture: { path: repository, allowedPaths: ["src/"], protectedPaths: ["test/"] } },
    verificationProfiles: {
      regression: [{ id: "regression", command: process.execPath, args: ["--test", "--test-reporter=tap", "test/page.test.mjs"], criteria: ["A1"], timeoutMs: 5000 }],
    },
    maxRetries: 2,
    maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath });

  try {
    await assert.rejects(async () => { await mounted; }, /NATIVE_FIXTURE_MODE_NOT_ALLOWED/);
    assert.equal(ctx.tools.get("devkit_doctor"), undefined);
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await disposePrompt();
  }
});

test("real official Codex provider is visible to the native doctor without starting Codex", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-codex-provider-"));
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "disabled",
    repositories: {},
    verificationProfiles: {},
    maxRetries: 2,
    maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const subagentsFiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await subagentsFiber;
  let spawnCalls = 0;
  const disposeSubprocess = ctx.provide("subprocess", {
    spawn() {
      spawnCalls += 1;
      throw new Error("the registration fixture must not start Codex");
    },
  });
  const providerFiber = ctx.plugin(codexProvider, {
    providerName: "codex",
    env: {},
    permissionMode: "never",
    disposeGraceMs: 3000,
  });
  await providerFiber;
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath });

  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.deepEqual(doctor.value.codexSubagent, {
      state: "supported",
      provider: "codex",
      permissionMode: "never",
      permissionEnforcement: "provider-declared",
      explicitEnvironment: "empty",
      writerSandbox: "unverified",
      writerProtocolEligible: false,
      writerLaunchEligible: false,
      writerLaunchBlockers: [
        "CODEX_PROVIDER_NOT_MANAGED_BY_DEVKIT",
        "CODEX_CREDENTIAL_BROKER_UNIMPLEMENTED",
        "CODEX_INTERACTIVE_APPROVAL_BROKER_UNIMPLEMENTED",
      ],
      nativeExecutorEligible: false,
      appServerBoundary: { state: "unconfigured", reason: "CODEX_PROVIDER_NOT_MANAGED_BY_DEVKIT" },
      liveValidated: false,
      inheritsParentContext: false,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
    });
    assert.equal(spawnCalls, 0);
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await providerFiber.dispose();
    await disposeSubprocess();
    await subagentsFiber.dispose();
    await disposePrompt();
  }
});

test("native doctor configures an independent reviewer without probing its credential or endpoint", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-reviewer-config-"));
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "disabled",
    reviewer: {
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-review",
      credentialEnv: "DSH_DEVKIT_REVIEWER_API_KEY",
      timeoutMs: 45000,
    },
    repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath });
  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.deepEqual(doctor.value.nativeRuntime.reviewer, {
      state: "configured", provider: "deepseek", model: "deepseek-review", credential: "deferred",
    });
    assert.deepEqual(doctor.value.reviewer, { family: "deepseek", kind: "live" });
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await disposePrompt();
  }
});

test("native doctor treats an externally mounted workspace-write provider as non-executable until DevKit owns its boundary", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-codex-workspace-write-"));
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"), executionMode: "disabled", repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const subagentsFiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await subagentsFiber;
  const disposeAgents = ctx.provide("agents", { create() { throw new Error("the doctor fixture must not create a candidate parent"); } });
  let spawnCalls = 0;
  const disposeSubprocess = ctx.provide("subprocess", {
    spawn() { spawnCalls += 1; throw new Error("the doctor fixture must not start Codex"); },
  });
  const providerFiber = ctx.plugin(codexProvider, {
    providerName: "codex", env: {}, permissionMode: "approve-for-me", disposeGraceMs: 3000,
  });
  await providerFiber;
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath });

  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.deepEqual(doctor.value.codexSubagent, {
      state: "supported",
      provider: "codex",
      permissionMode: "approve-for-me",
      permissionEnforcement: "provider-declared",
      explicitEnvironment: "empty",
      writerSandbox: "workspace-write-provider-declared",
      writerProtocolEligible: true,
      writerLaunchEligible: false,
      writerLaunchBlockers: [
        "CODEX_PROVIDER_NOT_MANAGED_BY_DEVKIT",
        "CODEX_CREDENTIAL_BROKER_UNIMPLEMENTED",
        "CODEX_INTERACTIVE_APPROVAL_BROKER_UNIMPLEMENTED",
      ],
      nativeExecutorEligible: false,
      appServerBoundary: { state: "unconfigured", reason: "CODEX_PROVIDER_NOT_MANAGED_BY_DEVKIT" },
      liveValidated: false,
      inheritsParentContext: false,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
    });
    const executor = native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: root } } } });
    assert.equal(executor, undefined);
    assert.equal(spawnCalls, 0);
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await providerFiber.dispose();
    await disposeSubprocess();
    await disposeAgents();
    await subagentsFiber.dispose();
    await disposePrompt();
  }
});

test("native mounts the official workspace-write provider in an isolated DevKit subprocess scope", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-managed-codex-provider-"));
  const protectedRoot = path.join(root, "protected");
  mkdirSync(protectedRoot);
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "disabled",
    codexAppServer: { mode: "macos-seatbelt-v1", deniedReadRoots: [protectedRoot] },
    repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const subagentsFiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await subagentsFiber;
  const disposeAgents = ctx.provide("agents", { create() { throw new Error("doctor fixture must not create a candidate parent"); } });
  let spawnCalls = 0;
  const disposeSubprocess = ctx.provide("subprocess", {
    spawn() { spawnCalls += 1; throw new Error("managed registration must not start Codex"); },
  });
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  let mounted = ctx.plugin(plugin, { configPath });
  let reloaded;

  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.deepEqual(doctor.value.codexSubagent.appServerBoundary, {
      state: "configured", id: "macos-seatbelt-app-server-v1", credentialBroker: "unimplemented",
    });
    assert.equal(doctor.value.codexSubagent.permissionMode, "approve-for-me");
    assert.equal(doctor.value.codexSubagent.writerProtocolEligible, true);
    assert.equal(doctor.value.codexSubagent.writerLaunchEligible, false);
    assert.deepEqual(doctor.value.codexSubagent.writerLaunchBlockers, [
      "CODEX_CREDENTIAL_BROKER_UNIMPLEMENTED",
      "CODEX_INTERACTIVE_APPROVAL_BROKER_UNIMPLEMENTED",
    ]);
    assert.equal(doctor.value.codexSubagent.nativeExecutorEligible, false);
    assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: root } } } }), undefined, "the exported helper does not receive the native-private boundary capability");
    assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: root } } } }, {
      provider: ctx.get("subagents").getProvider("codex"),
      boundary: { id: "test-boundary" },
    }), undefined, "even a managed boundary cannot start a writer until the credential and approval brokers exist");
    assert.equal(spawnCalls, 0);
    await mounted.dispose();
    mounted = undefined;
    assert.equal(ctx.get("subagents").getProvider("codex"), undefined, "disposing DevKit removes its root-scoped managed provider");
    reloaded = ctx.plugin(plugin, { configPath });
    await reloaded;
    const reloadedDoctor = await call(ctx.tools, "devkit_doctor", {}, 2);
    assert.equal(reloadedDoctor.value.codexSubagent.appServerBoundary.state, "configured", "the isolated provider can be mounted again without a stale registry entry");
    assert.equal(spawnCalls, 0);
  } finally {
    await reloaded?.dispose();
    await mounted?.dispose();
    await toolsFiber.dispose();
    await disposeSubprocess();
    await disposeAgents();
    await subagentsFiber.dispose();
    await disposePrompt();
  }
});

test("native doctor blocks a full-access Codex provider before it can become an executor", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-codex-full-access-"));
  const configPath = path.join(root, "policy.json");
  writeFileSync(configPath, JSON.stringify({
    dataRoot: path.join(root, "data"),
    executionMode: "disabled",
    repositories: {},
    verificationProfiles: {},
    maxRetries: 2,
    maxDurationMs: 10000,
  }));

  const ctx = new Context();
  const disposePrompt = ctx.provide("systemPrompt", { tools: () => () => {} });
  const subagentsFiber = ctx.plugin(SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 1 });
  await subagentsFiber;
  const disposeAgents = ctx.provide("agents", { create() { throw new Error("must not create a parent for a blocked provider"); } });
  let spawnCalls = 0;
  const disposeSubprocess = ctx.provide("subprocess", {
    spawn() {
      spawnCalls += 1;
      throw new Error("the full-access provider must never start");
    },
  });
  const providerFiber = ctx.plugin(codexProvider, {
    providerName: "codex",
    env: {},
    permissionMode: "dangerously-bypass-approvals-and-sandbox",
    disposeGraceMs: 3000,
  });
  await providerFiber;
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const mounted = ctx.plugin(plugin, { configPath });

  try {
    await mounted;
    const doctor = await call(ctx.tools, "devkit_doctor", {}, 1);
    assert.equal(doctor.isError, false);
    assert.deepEqual(doctor.value.codexSubagent, {
      state: "blocked",
      provider: "codex",
      reason: "CODEX_FULL_ACCESS_MODE_FORBIDDEN",
      permissionMode: "dangerously-bypass-approvals-and-sandbox",
    });
    assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: root } } } }), undefined);
    assert.equal(spawnCalls, 0);
  } finally {
    await mounted.dispose();
    await toolsFiber.dispose();
    await providerFiber.dispose();
    await disposeSubprocess();
    await disposeAgents();
    await subagentsFiber.dispose();
    await disposePrompt();
  }
});

test("native doctor fails closed when a Codex provider's permission mode cannot be read", () => {
  const provider = {};
  Object.defineProperty(provider, "config", {
    get() { throw new Error("unreadable provider configuration"); },
  });
  const ctx = {
    get(name) {
      if (name === "subagents") return { getProvider() { return provider; } };
      if (name === "agents") return { create() { throw new Error("must not create a parent for an unverified provider"); } };
      return undefined;
    },
  };

  assert.deepEqual(native.codexProviderStatus(ctx), {
    state: "blocked",
    provider: "codex",
    reason: "CODEX_PERMISSION_MODE_UNVERIFIED",
  });
  assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: "/fixture" } } } }), undefined);
});

test("native doctor rejects nonempty explicit Codex provider environments", () => {
  const provider = {
    config: { permissionMode: "approve-for-me", env: { PATH: "/unexpected" } },
    capabilities: {},
    inheritsParentContext: false,
  };
  const ctx = {
    get(name) {
      if (name === "subagents") return { getProvider() { return provider; } };
      if (name === "agents") return { create() { throw new Error("must not create a parent for an unverified provider environment"); } };
      return undefined;
    },
  };
  assert.deepEqual(native.codexProviderStatus(ctx), {
    state: "blocked", provider: "codex", reason: "CODEX_PROVIDER_ENV_NOT_EMPTY", permissionMode: "approve-for-me",
  });
  assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: "/fixture" } } } }), undefined);
});

test("native doctor requires an explicit empty Codex provider environment", () => {
  const provider = {
    config: { permissionMode: "approve-for-me" },
    capabilities: {},
    inheritsParentContext: false,
  };
  const ctx = {
    get(name) {
      if (name === "subagents") return { getProvider() { return provider; } };
      if (name === "agents") return { create() { throw new Error("must not create a parent for a provider without an explicit environment"); } };
      return undefined;
    },
  };
  assert.deepEqual(native.codexProviderStatus(ctx), {
    state: "blocked", provider: "codex", reason: "CODEX_PROVIDER_ENV_UNVERIFIED", permissionMode: "approve-for-me",
  });
  assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: "/fixture" } } } }), undefined);
});

test("native doctor fails closed when Codex provider metadata cannot be read", () => {
  const provider = { config: { permissionMode: "approve-for-me", env: {} } };
  Object.defineProperty(provider, "capabilities", {
    get() { throw new Error("unreadable provider metadata"); },
  });
  const ctx = {
    get(name) {
      if (name === "subagents") return { getProvider() { return provider; } };
      if (name === "agents") return { create() { throw new Error("must not create a parent for unreadable metadata"); } };
      return undefined;
    },
  };
  assert.deepEqual(native.codexProviderStatus(ctx), {
    state: "blocked", provider: "codex", reason: "CODEX_PROVIDER_METADATA_UNVERIFIED", permissionMode: "approve-for-me",
  });
  assert.equal(native.codexExecutor(ctx, { agent: { session: { id: "parent", header: { cwd: "/fixture" } } } }), undefined);
});

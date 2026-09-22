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
import * as native from "../../native/index.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepository(root) {
  const repository = path.join(root, "repository");
  mkdirSync(path.join(repository, "src"), { recursive: true });
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, "src", "page.mjs"), "export const page = 1;\n");
  writeFileSync(path.join(repository, "test", "page.test.mjs"), "import test from 'node:test'; test('fixture', () => {});\n");
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

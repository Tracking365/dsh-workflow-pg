import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { LlmAdapter, createUserMessage, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as native from "../../native/index.mjs";

const FIXTURE_PROVIDER = "devkit-session-fixture";
const FIXTURE_MODEL = "offline-model";
const FIXTURE_CALL_ID = "fixture-doctor-call";

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(signal.reason), { once: true }));
}

function textStream(text) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/**
 * A deliberately local LLM adapter. It models only fixed protocol replies and
 * never has credentials, an endpoint, or a network implementation.
 */
class OfflineSessionFixtureAdapter extends LlmAdapter {
  constructor(steps) {
    super();
    this.steps = [...steps];
    this.requests = [];
    this.cancellationStarted = Promise.withResolvers();
    this.cancellationObserved = Promise.withResolvers();
  }

  async *stream(options) {
    const step = this.steps.shift();
    assert.ok(step, "the fixture received an unexpected model request");
    assert.equal(options.provider, FIXTURE_PROVIDER);
    assert.equal(options.model, FIXTURE_MODEL);
    assert.equal(isAgentLoopRequest(options), true, "the fixture must only receive AgentLoop-built requests");
    this.requests.push({
      messages: structuredClone(options.messages),
      tools: structuredClone(options.tools ?? []),
    });

    if (step === "doctor") {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: FIXTURE_CALL_ID, name: "devkit_doctor", argumentsDelta: "{}" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: FIXTURE_CALL_ID, name: "devkit_doctor", arguments: "{}" },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    if (step === "final") {
      yield* textStream("Fixture session completed after devkit_doctor.");
      return;
    }

    if (step === "cancel") {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "Partial fixture response" };
      this.cancellationStarted.resolve();
      this.cancellationObserved.resolve(await waitForAbort(options.signal));
      return;
    }

    throw new Error(`unknown offline fixture step: ${step}`);
  }
}

function userMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

async function createHarness(adapter) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-agent-session-"));
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
  const llmFiber = ctx.plugin(LlmRuntime);
  await llmFiber;
  const sessionsFiber = ctx.plugin(SessionStore);
  await sessionsFiber;
  const projectionsFiber = ctx.plugin(SessionProjectionRegistry);
  await projectionsFiber;
  const promptFiber = ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    personaPrefix: "Offline DevKit session fixture.",
    personaSuffix: "",
  });
  await promptFiber;
  const agentsFiber = ctx.plugin(AgentRegistry);
  await agentsFiber;
  const toolsFiber = ctx.plugin(ToolRuntime);
  await toolsFiber;
  const loopFiber = ctx.plugin(AgentLoop, { agents: [] });
  await loopFiber;
  const disposeAdapter = ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter);
  const plugin = { name: native.name, inject: native.inject, apply: native.apply };
  const devkitFiber = ctx.plugin(plugin, { configPath });
  await devkitFiber;

  return {
    ctx,
    async dispose() {
      await devkitFiber.dispose();
      disposeAdapter();
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

test("offline DSH AgentLoop fixture selects DevKit, renders its result, and preserves streamed text on cancellation", { timeout: 10000 }, async () => {
  const adapter = new OfflineSessionFixtureAdapter(["doctor", "final", "cancel"]);
  const harness = await createHarness(adapter);
  let completed;
  let cancelled;

  try {
    completed = await harness.ctx.agents.create({
      sessionId: "offline-devkit-completed-session",
      agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    });
    completed.agent.followup(userMessage("Check DevKit capabilities, then summarize the result."));
    await completed.agent.whenIdle();

    assert.equal(adapter.requests.length, 2);
    assert.ok(adapter.requests[0].tools.some((tool) => tool.name === "devkit_doctor"), "the native DevKit schema is presented to the model");
    assert.ok(adapter.requests[1].messages.some((message) => message.content.some((block) => block.type === "tool-result")), "the next model step receives the rendered tool result");

    const completedEvents = completed.agent.session.snapshotEvents();
    const call = completedEvents.find((event) => event.type === "tool/call");
    assert.equal(call?.data.name, "devkit_doctor");
    assert.equal(call?.data.callId, FIXTURE_CALL_ID);
    const result = completedEvents.find((event) => event.type === "tool/result");
    assert.ok(result, "the AgentLoop persisted the selected tool result");
    const rendered = result.data.message.content[0];
    assert.equal(rendered.type, "tool-result");
    assert.equal(rendered.isError, false);
    const doctor = JSON.parse(rendered.content[0].text);
    assert.equal(doctor.executionMode, "disabled");
    assert.equal(doctor.live.reason, "LIVE_SANDBOX_NOT_IMPLEMENTED");
    assert.deepEqual(doctor.nativeRuntime, { state: "supported", registry: "dsh-tools", fixtureMode: "disabled", reviewer: { state: "unconfigured" } });
    assert.deepEqual(doctor.codexSubagent, { state: "unconfigured", reason: "DSH_SUBAGENT_SERVICE_MISSING" });
    const completedMessage = completedEvents.findLast((event) => event.type === "assistant/message");
    assert.deepEqual(completedMessage?.data.message.content, [{ type: "text", text: "Fixture session completed after devkit_doctor." }]);

    cancelled = await harness.ctx.agents.create({
      sessionId: "offline-devkit-cancelled-session",
      agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    });
    cancelled.agent.followup(userMessage("Start a response that I will cancel."));
    await adapter.cancellationStarted.promise;
    cancelled.agent.cancel({ kind: "user" });
    assert.deepEqual(await adapter.cancellationObserved.promise, { kind: "user" }, "the live Agent cancellation signal reaches the local model fixture");
    await cancelled.agent.whenIdle();

    const cancelledEvents = cancelled.agent.session.snapshotEvents();
    const partial = cancelledEvents.find((event) => event.type === "assistant/message");
    assert.equal(partial?.data.interrupted, true);
    assert.deepEqual(partial?.data.message.content, [{ type: "text", text: "Partial fixture response" }]);
    const turnEnd = cancelledEvents.findLast((event) => event.type === "turn/end");
    assert.deepEqual(turnEnd?.data.reason, { kind: "aborted", reason: { kind: "user" } });
    assert.equal(cancelled.agent.status, "idle");
    assert.equal(adapter.steps.length, 0);
  } finally {
    await cancelled?.dispose();
    await completed?.dispose();
    await harness.dispose();
  }
});

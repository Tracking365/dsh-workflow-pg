// Thin DSH/Cordis boundary. See docs/DSH_COMPATIBILITY.md for the verified
// ToolRuntime and launcher fixtures, plus the remaining agent-session gates.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Devkit, DevkitError, assertPaginationFixturePolicy, createDshCandidateWorkspaceCodexExecutor, createPaginationFixtureAdapters, object, PAGINATION_FIXTURE_DRIVER, text, redact, validateHostPolicy } from "../dist/src/index.js";

export const name = "devkit";
export const inject = ["tools"];
const SAFE_CODEX_PERMISSION_MODES = new Set(["never", "approve-for-me"]);
const DANGEROUS_CODEX_PERMISSION_MODE = "dangerously-bypass-approvals-and-sandbox";
const string = { type: "string", minLength: 1 };
const list = { type: "array", items: string };
const record = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const taskSchema = record({
  kind: { type: "string", enum: ["bugfix"] }, title: string, description: string, repositoryRef: string,
  baseRef: string, reproduction: record({ steps: list, expected: string, actual: string }),
  acceptanceCriteria: { type: "array", minItems: 1, items: record({ id: string, description: string }) },
  verificationProfile: string, contextRefs: list, idempotencyKey: string,
}, ["kind", "title", "description", "repositoryRef", "reproduction", "acceptanceCriteria", "verificationProfile"]);
const idSchema = record({ taskId: string });
const parseId = args => text(object(args, ["taskId"]).taskId, "taskId", 100);

function codexProvider(ctx) {
  // `subagents` is optional: a normal property read requires the plugin to
  // declare it in `inject`, whereas `get()` safely probes an optional service.
  const subagents = ctx.get("subagents");
  if (!subagents || typeof subagents.getProvider !== "function") return undefined;
  const provider = subagents.getProvider("codex");
  return provider;
}

function codexPermissionMode(provider) {
  // Treat an unreadable provider configuration as unverified instead of
  // allowing a plugin implementation detail to bypass this fail-closed gate.
  try {
    const mode = provider?.config?.permissionMode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    return undefined;
  }
}

function isSafeCodexProvider(provider) {
  return SAFE_CODEX_PERMISSION_MODES.has(codexPermissionMode(provider));
}

export function codexProviderStatus(ctx) {
  const subagents = ctx.get("subagents");
  if (!subagents || typeof subagents.getProvider !== "function") {
    return { state: "unconfigured", reason: "DSH_SUBAGENT_SERVICE_MISSING" };
  }
  const provider = codexProvider(ctx);
  if (!provider) return { state: "unconfigured", reason: "CODEX_PROVIDER_MISSING" };
  const permissionMode = codexPermissionMode(provider);
  if (!isSafeCodexProvider(provider)) {
    return {
      state: "blocked",
      provider: "codex",
      reason: permissionMode === DANGEROUS_CODEX_PERMISSION_MODE
        ? "CODEX_FULL_ACCESS_MODE_FORBIDDEN"
        : "CODEX_PERMISSION_MODE_UNVERIFIED",
      ...(permissionMode === undefined ? {} : { permissionMode }),
    };
  }
  const capabilities = provider.capabilities ?? {};
  return {
    state: "supported",
    provider: "codex",
    permissionMode,
    permissionEnforcement: "provider-declared",
    liveValidated: false,
    inheritsParentContext: provider.inheritsParentContext === true,
    capabilities: {
      agentOptions: capabilities.agentOptions === true,
      outputSchema: capabilities.outputSchema === true,
      depthLimit: capabilities.depthLimit === true,
      toolFilter: capabilities.toolFilter === true,
      persona: capabilities.persona === true,
    },
  };
}

export function codexExecutor(ctx, exec) {
  const subagents = ctx.get("subagents");
  const agents = ctx.get("agents");
  const provider = codexProvider(ctx);
  if (!exec.agent || !agents || typeof agents.create !== "function" || !subagents || typeof subagents.getProvider !== "function" || !isSafeCodexProvider(provider)) return undefined;
  return createDshCandidateWorkspaceCodexExecutor({ agents, subagents, parent: exec.agent });
}

/** Pure definition factory permits contract tests without pretending to run a DSH Context. */
export function toolDefinitions(runtime, services = {}) {
  const define = (name, description, parameters, handler) => ({
    name, description, parameters,
    output: {
      schema: { type: "object", properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const value = await handler(args, exec);
      return JSON.parse(redact(JSON.stringify(value)));
    },
  });
  return [
    define("devkit_doctor", "Inspect actual capabilities; does not call a model.", record({}), args => { object(args, []); return services.doctor ? services.doctor() : runtime.doctor(); }),
    define("dev_task_create", "Create a task in a host-authorized repository; does not execute code.", taskSchema, args => runtime.create(args)),
    define("dev_task_run", services.fixtureMode === true
      ? "Run the explicit deterministic pagination fixture; it cannot select arbitrary code or commands."
      : "Run an authorized task. Live writes are currently blocked pending sandbox integration.", idSchema, (args, exec) => runtime.run(parseId(args), exec.signal, services.executor ? services.executor(exec) : undefined)),
    define("dev_task_status", "Read the durable task state and readiness, not a model summary.", idSchema, args => runtime.status(parseId(args))),
    define("dev_task_cancel", "Request cancellation and wait for the owned operation to settle.", idSchema, args => runtime.cancel(parseId(args))),
    define("dev_task_resume", "Check recovery eligibility; unresolved recovery requires an operator.", idSchema, args => runtime.resume(parseId(args))),
    define("dev_task_report", "Read task events, artifacts and explicit evidence mode.", idSchema, args => runtime.report(parseId(args))),
  ];
}

export function apply(ctx, config = {}) {
  const options = object(config, ["configPath", "fixtureDriver"]);
  const configPath = options.configPath ?? process.env.DSH_DEVKIT_CONFIG;
  const fixtureDriver = options.fixtureDriver === undefined ? undefined : text(options.fixtureDriver, "fixtureDriver", 100);
  let policy = { dataRoot: path.join(os.homedir(), ".dsh-devkit"), executionMode: "disabled", repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 600000 };
  if (configPath !== undefined) {
    const file = text(configPath, "configPath");
    if (!path.isAbsolute(file)) throw new DevkitError("CONFIG_PATH_MUST_BE_ABSOLUTE");
    const content = readFileSync(file);
    if (content.byteLength > 65536) throw new DevkitError("CONFIG_SIZE_LIMIT");
    policy = validateHostPolicy(JSON.parse(content.toString("utf8")));
  }
  if (policy.executionMode === "fixture") {
    // Two independent trusted host settings are required. A model-facing task
    // cannot set either one, and this adapter never becomes a generic runner.
    if (fixtureDriver !== PAGINATION_FIXTURE_DRIVER || policy.fixtureDriver !== PAGINATION_FIXTURE_DRIVER) throw new DevkitError("NATIVE_FIXTURE_MODE_NOT_ALLOWED");
    assertPaginationFixturePolicy(policy);
  } else if (fixtureDriver !== undefined) {
    throw new DevkitError("NATIVE_FIXTURE_MODE_NOT_ALLOWED");
  }
  const runtime = new Devkit(policy, policy.executionMode === "fixture" ? createPaginationFixtureAdapters() : {});
  ctx.on("dispose", () => runtime.close());
  for (const definition of toolDefinitions(runtime, {
    doctor: () => ({
      ...runtime.doctor(),
      nativeRuntime: {
        state: "supported",
        registry: "dsh-tools",
        fixtureMode: policy.executionMode === "fixture" ? PAGINATION_FIXTURE_DRIVER : "disabled",
      },
      codexSubagent: codexProviderStatus(ctx),
    }),
    fixtureMode: policy.executionMode === "fixture",
    executor: policy.executionMode === "fixture" ? undefined : exec => codexExecutor(ctx, exec),
  })) ctx.tools.register(definition);
}

// Thin DSH/Cordis boundary. API source and unverified runtime status: docs/DSH_COMPATIBILITY.md.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Devkit, DevkitError, object, text, redact, validateHostPolicy } from "../dist/src/index.js";

export const name = "devkit";
export const inject = ["tools"];
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

/** Pure definition factory permits contract tests without pretending to run a DSH Context. */
export function toolDefinitions(runtime) {
  const define = (name, description, parameters, handler) => ({
    name, description, parameters,
    output: {
      schema: { type: "object", properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const value = await handler(args, exec.signal);
      return JSON.parse(redact(JSON.stringify(value)));
    },
  });
  return [
    define("devkit_doctor", "Inspect actual capabilities; does not call a model.", record({}), args => { object(args, []); return runtime.doctor(); }),
    define("dev_task_create", "Create a task in a host-authorized repository; does not execute code.", taskSchema, args => runtime.create(args)),
    define("dev_task_run", "Run an authorized task. Live writes are currently blocked pending sandbox integration.", idSchema, (args, signal) => runtime.run(parseId(args), signal)),
    define("dev_task_status", "Read the durable task state and readiness, not a model summary.", idSchema, args => runtime.status(parseId(args))),
    define("dev_task_cancel", "Request cancellation and wait for the owned operation to settle.", idSchema, args => runtime.cancel(parseId(args))),
    define("dev_task_resume", "Check recovery eligibility; unresolved recovery requires an operator.", idSchema, args => runtime.resume(parseId(args))),
    define("dev_task_report", "Read task events, artifacts and explicit evidence mode.", idSchema, args => runtime.report(parseId(args))),
  ];
}

export function apply(ctx, config = {}) {
  const options = object(config, ["configPath"]);
  const configPath = options.configPath ?? process.env.DSH_DEVKIT_CONFIG;
  let policy = { dataRoot: path.join(os.homedir(), ".dsh-devkit"), executionMode: "disabled", repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 600000 };
  if (configPath !== undefined) {
    const file = text(configPath, "configPath");
    if (!path.isAbsolute(file)) throw new DevkitError("CONFIG_PATH_MUST_BE_ABSOLUTE");
    const content = readFileSync(file);
    if (content.byteLength > 65536) throw new DevkitError("CONFIG_SIZE_LIMIT");
    policy = validateHostPolicy(JSON.parse(content.toString("utf8")));
  }
  // Fixture adapters are only constructed by tests/demo, never silently installed in DSH.
  if (policy.executionMode !== "disabled") throw new DevkitError("NATIVE_FIXTURE_MODE_NOT_ALLOWED");
  const runtime = new Devkit(policy);
  ctx.on("dispose", () => runtime.close());
  for (const definition of toolDefinitions(runtime)) ctx.tools.register(definition);
}

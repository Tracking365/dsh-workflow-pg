import path from "node:path";
import { DevkitError, object, strings, text } from "./task.js";
import type { HostPolicy, RepositoryPolicy } from "../plugins/tasks.js";
import type { CommandSpec } from "../adapters/process.js";

/** This schema belongs to the trusted host, never to a model-facing tool. */
export function validateHostPolicy(value: unknown): HostPolicy {
  const p = object(value, ["dataRoot", "executionMode", "fixtureDriver", "repositories", "verificationProfiles", "maxRetries", "maxDurationMs"]);
  const dataRoot = text(p.dataRoot, "dataRoot");
  const executionMode = String(p.executionMode);
  if (!path.isAbsolute(dataRoot) || !["disabled", "fixture"].includes(executionMode)) throw new DevkitError("INVALID_HOST_POLICY");
  const fixtureDriver = p.fixtureDriver === undefined ? undefined : text(p.fixtureDriver, "fixtureDriver", 100);
  if ((executionMode === "fixture" && fixtureDriver !== "pagination-v1") || (executionMode !== "fixture" && fixtureDriver !== undefined)) throw new DevkitError("INVALID_FIXTURE_DRIVER");
  const map = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DevkitError("INVALID_HOST_POLICY");
    return object(value, Object.keys(value));
  };
  const repositories: Record<string, RepositoryPolicy> = Object.create(null) as Record<string, RepositoryPolicy>;
  for (const [alias, value] of Object.entries(map(p.repositories))) {
    text(alias, "repository alias", 100);
    const repo = object(value, ["path", "allowedPaths", "protectedPaths"]), location = text(repo.path, "repository.path");
    if (!path.isAbsolute(location)) throw new DevkitError("INVALID_REPOSITORY_PATH");
    repositories[alias] = { path: location, allowedPaths: strings(repo.allowedPaths, "allowedPaths"), protectedPaths: strings(repo.protectedPaths, "protectedPaths") };
  }
  const verificationProfiles: Record<string, CommandSpec[]> = Object.create(null) as Record<string, CommandSpec[]>;
  for (const [alias, value] of Object.entries(map(p.verificationProfiles))) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new DevkitError("INVALID_VERIFICATION_PLAN");
    verificationProfiles[alias] = value.map(value => {
      const c = object(value, ["id", "command", "args", "criteria", "timeoutMs"]);
      if (!Number.isSafeInteger(c.timeoutMs) || Number(c.timeoutMs) <= 0 || Number(c.timeoutMs) > 3600000) throw new DevkitError("INVALID_COMMAND_TIMEOUT");
      return { id: text(c.id, "checkId"), command: text(c.command, "command"), args: strings(c.args, "args", true), criteria: strings(c.criteria, "criteria"), timeoutMs: Number(c.timeoutMs) };
    });
  }
  if (!Number.isInteger(p.maxRetries) || Number(p.maxRetries) < 0 || Number(p.maxRetries) > 2 || !Number.isSafeInteger(p.maxDurationMs) || Number(p.maxDurationMs) <= 0 || Number(p.maxDurationMs) > 3600000) throw new DevkitError("INVALID_BUDGET");
  return {
    dataRoot,
    executionMode: executionMode as HostPolicy["executionMode"],
    ...(fixtureDriver === undefined ? {} : { fixtureDriver: fixtureDriver as "pagination-v1" }),
    repositories,
    verificationProfiles,
    maxRetries: Number(p.maxRetries),
    maxDurationMs: Number(p.maxDurationMs),
  };
}

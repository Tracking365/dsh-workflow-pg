import path from "node:path";
import { contextReference, DevkitError, object, strings, text } from "./task.js";
import type { HostPolicy, RepositoryPolicy } from "../plugins/tasks.js";
import type { CommandSpec } from "../adapters/process.js";

/** This schema belongs to the trusted host, never to a model-facing tool. */
export function validateHostPolicy(value: unknown): HostPolicy {
  const p = object(value, ["dataRoot", "executionMode", "fixtureDriver", "reviewer", "codexAppServer", "codexApprovalControlPlane", "recoveryControlPlane", "repositories", "verificationProfiles", "maxRetries", "maxDurationMs"]);
  const dataRoot = text(p.dataRoot, "dataRoot");
  const executionMode = String(p.executionMode);
  if (!path.isAbsolute(dataRoot) || !["disabled", "fixture"].includes(executionMode)) throw new DevkitError("INVALID_HOST_POLICY");
  const fixtureDriver = p.fixtureDriver === undefined ? undefined : text(p.fixtureDriver, "fixtureDriver", 100);
  if ((executionMode === "fixture" && fixtureDriver !== "pagination-v1") || (executionMode !== "fixture" && fixtureDriver !== undefined)) throw new DevkitError("INVALID_FIXTURE_DRIVER");
  let reviewer: HostPolicy["reviewer"];
  if (p.reviewer !== undefined) {
    if (executionMode === "fixture") throw new DevkitError("LIVE_REVIEWER_NOT_ALLOWED_IN_FIXTURE");
    const r = object(p.reviewer, ["endpoint", "model", "credentialEnv", "timeoutMs"]);
    const endpoint = text(r.endpoint, "reviewer.endpoint", 500);
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/chat/completions")) throw new DevkitError("INVALID_REVIEW_ENDPOINT");
    } catch (error) {
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("INVALID_REVIEW_ENDPOINT");
    }
    const credentialEnv = text(r.credentialEnv, "reviewer.credentialEnv", 100);
    if (!/^DSH_DEVKIT_[A-Z0-9_]{1,80}$/.test(credentialEnv)) throw new DevkitError("INVALID_REVIEW_CREDENTIAL_ENV");
    if (r.timeoutMs !== undefined && (!Number.isSafeInteger(r.timeoutMs) || Number(r.timeoutMs) < 1000 || Number(r.timeoutMs) > 120000)) throw new DevkitError("INVALID_REVIEW_TIMEOUT");
    reviewer = { endpoint, model: text(r.model, "reviewer.model", 200), credentialEnv, ...(r.timeoutMs === undefined ? {} : { timeoutMs: Number(r.timeoutMs) }) };
  }
  let codexAppServer: HostPolicy["codexAppServer"];
  if (p.codexAppServer !== undefined) {
    if (executionMode === "fixture") throw new DevkitError("LIVE_APP_SERVER_BOUNDARY_NOT_ALLOWED_IN_FIXTURE");
    const c = object(p.codexAppServer, ["mode", "deniedReadRoots"]);
    if (c.mode !== "macos-seatbelt-v1") throw new DevkitError("INVALID_APP_SERVER_BOUNDARY");
    const deniedReadRoots = strings(c.deniedReadRoots, "codexAppServer.deniedReadRoots", true);
    if (!deniedReadRoots.length || deniedReadRoots.length > 20 || deniedReadRoots.some((root) => !path.isAbsolute(root))) throw new DevkitError("INVALID_APP_SERVER_BOUNDARY");
    codexAppServer = { mode: "macos-seatbelt-v1", deniedReadRoots };
  }
  let codexApprovalControlPlane: HostPolicy["codexApprovalControlPlane"];
  if (p.codexApprovalControlPlane !== undefined) {
    if (executionMode === "fixture") throw new DevkitError("LIVE_APPROVAL_CONTROL_PLANE_NOT_ALLOWED_IN_FIXTURE");
    const c = object(p.codexApprovalControlPlane, ["mode", "credentialEnv", "operatorId", "port"]);
    if (c.mode !== "loopback-v1") throw new DevkitError("INVALID_APPROVAL_CONTROL_PLANE");
    const credentialEnv = text(c.credentialEnv, "codexApprovalControlPlane.credentialEnv", 100);
    if (!/^DSH_DEVKIT_[A-Z0-9_]{1,80}$/.test(credentialEnv)) throw new DevkitError("INVALID_APPROVAL_CONTROL_PLANE");
    const operatorId = text(c.operatorId, "codexApprovalControlPlane.operatorId", 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(operatorId)) throw new DevkitError("INVALID_APPROVAL_CONTROL_PLANE");
    if (c.port !== undefined && (!Number.isSafeInteger(c.port) || Number(c.port) < 0 || Number(c.port) > 65535)) throw new DevkitError("INVALID_APPROVAL_CONTROL_PLANE");
    codexApprovalControlPlane = {
      mode: "loopback-v1",
      credentialEnv,
      operatorId,
      ...(c.port === undefined ? {} : { port: Number(c.port) }),
    };
  }
  let recoveryControlPlane: HostPolicy["recoveryControlPlane"];
  if (p.recoveryControlPlane !== undefined) {
    if (executionMode === "fixture") throw new DevkitError("LIVE_RECOVERY_CONTROL_PLANE_NOT_ALLOWED_IN_FIXTURE");
    const c = object(p.recoveryControlPlane, ["mode", "credentialEnv", "operatorId", "port"]);
    if (c.mode !== "loopback-v1") throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE");
    const credentialEnv = text(c.credentialEnv, "recoveryControlPlane.credentialEnv", 100);
    if (!/^DSH_DEVKIT_[A-Z0-9_]{1,80}$/.test(credentialEnv)) throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE");
    const operatorId = text(c.operatorId, "recoveryControlPlane.operatorId", 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(operatorId)) throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE");
    if (c.port !== undefined && (!Number.isSafeInteger(c.port) || Number(c.port) < 0 || Number(c.port) > 65535)) throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE");
    recoveryControlPlane = {
      mode: "loopback-v1",
      credentialEnv,
      operatorId,
      ...(c.port === undefined ? {} : { port: Number(c.port) }),
    };
  }
  const map = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DevkitError("INVALID_HOST_POLICY");
    return object(value, Object.keys(value));
  };
  const repositories: Record<string, RepositoryPolicy> = Object.create(null) as Record<string, RepositoryPolicy>;
  for (const [alias, value] of Object.entries(map(p.repositories))) {
    text(alias, "repository alias", 100);
    const repo = object(value, ["path", "allowedPaths", "protectedPaths", "contextPaths"]), location = text(repo.path, "repository.path");
    if (!path.isAbsolute(location)) throw new DevkitError("INVALID_REPOSITORY_PATH");
    let contextPaths: string[] | undefined;
    if (repo.contextPaths !== undefined) {
      if (!Array.isArray(repo.contextPaths) || !repo.contextPaths.length || repo.contextPaths.length > 20) throw new DevkitError("INVALID_CONTEXT_POLICY");
      contextPaths = repo.contextPaths.map((entry, index) => contextReference(entry, `contextPaths[${index}]`, true)).sort();
      if (new Set(contextPaths).size !== contextPaths.length) throw new DevkitError("DUPLICATE_CONTEXT_POLICY_PATH");
    }
    repositories[alias] = {
      path: location,
      allowedPaths: strings(repo.allowedPaths, "allowedPaths"),
      protectedPaths: strings(repo.protectedPaths, "protectedPaths"),
      ...(contextPaths === undefined ? {} : { contextPaths }),
    };
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
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(codexAppServer === undefined ? {} : { codexAppServer }),
    ...(codexApprovalControlPlane === undefined ? {} : { codexApprovalControlPlane }),
    ...(recoveryControlPlane === undefined ? {} : { recoveryControlPlane }),
    repositories,
    verificationProfiles,
    maxRetries: Number(p.maxRetries),
    maxDurationMs: Number(p.maxDurationMs),
  };
}

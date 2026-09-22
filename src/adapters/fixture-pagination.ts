import { readFileSync, writeFileSync } from "node:fs";
import { DevkitError, object } from "../contracts/task.js";
import { resolveRealWithin } from "../domain/security.js";
import type { Reviewer, ReviewRequest, ReviewResult } from "./review.js";
import type { CodeExecutor, ExecutionRequest, ExecutionResult, HostPolicy, RuntimeAdapters } from "../plugins/tasks.js";

/**
 * The sole built-in native fixture. It deliberately recognizes one tiny,
 * content-addressable repository rather than becoming a generic local runner.
 */
export const PAGINATION_FIXTURE_DRIVER = "pagination-v1" as const;
export const PAGINATION_FIXTURE_MARKER = ".dsh-devkit-fixture.json";
export const PAGINATION_BROKEN_SOURCE = "export const normalizePage = input => input ?? 1;\n";
export const PAGINATION_FIXED_SOURCE = "export const normalizePage = input => Number.isInteger(input) && input > 0 ? input : 1;\n";
export const PAGINATION_TEST_SOURCE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {normalizePage} from '../src/page.mjs';\ntest('invalid pages',()=>{for(const value of [undefined,0,-1,1.5,NaN,Infinity]) assert.equal(normalizePage(value),1);});\ntest('positive integers',()=>{for(const value of [1,2,50]) assert.equal(normalizePage(value),value);});\n";

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function readFixtureFile(root: string, name: string): string {
  try {
    return readFileSync(resolveRealWithin(root, name), "utf8");
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError("FIXTURE_FILE_MISSING", name);
  }
}

function assertMarker(root: string): void {
  let value: unknown;
  try {
    value = JSON.parse(readFixtureFile(root, PAGINATION_FIXTURE_MARKER));
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError("FIXTURE_MARKER_INVALID");
  }
  const marker = object(value, ["schemaVersion", "driver"]);
  if (marker.schemaVersion !== 1 || marker.driver !== PAGINATION_FIXTURE_DRIVER) throw new DevkitError("FIXTURE_MARKER_INVALID");
}

/** Ensure the cloned candidate cannot substitute arbitrary fixture code. */
export function assertPaginationFixtureWorkspace(workspace: string): void {
  assertMarker(workspace);
  const source = readFixtureFile(workspace, "src/page.mjs");
  if (source !== PAGINATION_BROKEN_SOURCE && source !== PAGINATION_FIXED_SOURCE) throw new DevkitError("FIXTURE_SOURCE_UNEXPECTED", "src/page.mjs");
  if (readFixtureFile(workspace, "test/page.test.mjs") !== PAGINATION_TEST_SOURCE) throw new DevkitError("FIXTURE_SOURCE_UNEXPECTED", "test/page.test.mjs");
}

/**
 * Keep the native no-model path incapable of selecting another repository,
 * command or test plan through a task prompt or a loosely written config file.
 */
export function assertPaginationFixturePolicy(policy: HostPolicy): void {
  if (policy.executionMode !== "fixture" || policy.fixtureDriver !== PAGINATION_FIXTURE_DRIVER) throw new DevkitError("FIXTURE_DRIVER_NOT_AUTHORIZED");
  const repositories = Object.entries(policy.repositories);
  if (repositories.length !== 1 || repositories[0]?.[0] !== "fixture") throw new DevkitError("FIXTURE_REPOSITORY_POLICY_INVALID");
  const repository = repositories[0]?.[1];
  if (policy.recoveryControlPlane !== undefined || policy.findingAdjudicationControlPlane !== undefined || !repository || repository.contextPaths !== undefined || !sameList(repository.allowedPaths, ["src/"]) || !sameList(repository.protectedPaths, ["test/"])) throw new DevkitError("FIXTURE_REPOSITORY_POLICY_INVALID");
  const profiles = Object.entries(policy.verificationProfiles);
  if (profiles.length !== 1 || profiles[0]?.[0] !== "regression") throw new DevkitError("FIXTURE_VERIFICATION_POLICY_INVALID");
  const checks = profiles[0]?.[1];
  const check = checks?.[0];
  if (!checks || checks.length !== 1 || !check || check.id !== "regression" || check.command !== process.execPath || !sameList(check.args, ["--test", "--test-reporter=tap", "test/page.test.mjs"]) || !sameList(check.criteria, ["A1"]) || check.timeoutMs > 10_000) throw new DevkitError("FIXTURE_VERIFICATION_POLICY_INVALID");
  assertPaginationFixtureWorkspace(repository.path);
}

/** Deterministic host code: it neither launches a process nor calls a model. */
export class PaginationFixtureExecutor implements CodeExecutor {
  readonly family = "fixture-pagination-executor";
  readonly kind = "fixture" as const;

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    request.signal.throwIfAborted();
    assertPaginationFixtureWorkspace(request.workspace);
    if (!sameList(request.allowedPaths, ["src/"]) || !sameList(request.protectedPaths, ["test/"])) return { stopped: true, failure: "FIXTURE_SCOPE_MISMATCH" };
    const file = resolveRealWithin(request.workspace, "src/page.mjs");
    if (readFileSync(file, "utf8") !== PAGINATION_BROKEN_SOURCE) return { stopped: true, failure: "FIXTURE_SOURCE_UNEXPECTED" };
    writeFileSync(file, PAGINATION_FIXED_SOURCE, { encoding: "utf8" });
    request.signal.throwIfAborted();
    return { stopped: true, runId: PAGINATION_FIXTURE_DRIVER };
  }
}

/** Separate deterministic reviewer identity keeps fixture author/reviewer roles distinct. */
export class PaginationFixtureReviewer implements Reviewer {
  readonly family = "fixture-pagination-reviewer";
  readonly kind = "fixture" as const;

  async review(request: ReviewRequest): Promise<ReviewResult> {
    request.signal.throwIfAborted();
    return {
      snapshotId: request.snapshotId,
      reviewerId: "fixture-pagination-reviewer",
      provider: "fixture",
      model: "deterministic-pagination-v1",
      findings: [],
    };
  }
}

export function createPaginationFixtureAdapters(): RuntimeAdapters {
  return {
    executor: new PaginationFixtureExecutor(),
    reviewer: new PaginationFixtureReviewer(),
    workspaceGuard: { id: PAGINATION_FIXTURE_DRIVER, assertWorkspace: assertPaginationFixtureWorkspace },
  };
}

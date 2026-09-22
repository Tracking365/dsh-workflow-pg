import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Devkit, git, PAGINATION_BROKEN_SOURCE, PAGINATION_FIXED_SOURCE, PAGINATION_FIXTURE_DRIVER, PAGINATION_FIXTURE_MARKER, PAGINATION_TEST_SOURCE, parseFindings, type HostPolicy, type RuntimeAdapters, type Reviewer, type CodeExecutor } from "../src/index.js";
export const broken = PAGINATION_BROKEN_SOURCE;
export const fixed = PAGINATION_FIXED_SOURCE;
export const input = { kind: "bugfix", title: "Normalize invalid pages", description: "Return 1 for invalid page numbers.", repositoryRef: "fixture", verificationProfile: "regression", reproduction: { steps: ["Pass zero to normalizePage"], expected: "1", actual: "0" }, acceptanceCriteria: [{ id: "A1", description: "Invalid pages normalize to 1 and positive integers are preserved" }] };
export const finding = (severity: "P0" | "P1" | "P2" | "P3" = "P1") => parseFindings({ findings: [{ severity, title: "Potential boundary error", path: "src/page.mjs", line: 1, ruleId: "boundary", trigger: "invalid page", impact: "wrong result", evidence: ["fixture evidence; not a real model finding"] }] })[0]!;
export function fixture(overrides: Partial<HostPolicy> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "devkit-test-")), repo = path.join(root, "repo"), data = path.join(root, "data");
  mkdirSync(path.join(repo, "src"), { recursive: true }); mkdirSync(path.join(repo, "test"));
  writeFileSync(path.join(repo, PAGINATION_FIXTURE_MARKER), `${JSON.stringify({ schemaVersion: 1, driver: PAGINATION_FIXTURE_DRIVER })}\n`);
  writeFileSync(path.join(repo, "src/page.mjs"), broken);
  writeFileSync(path.join(repo, "test/page.test.mjs"), PAGINATION_TEST_SOURCE);
  git(repo, ["init", "--initial-branch=main"]); git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=DevKit Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "test fixture"]);
  const policy: HostPolicy = { dataRoot: data, executionMode: "fixture", fixtureDriver: PAGINATION_FIXTURE_DRIVER, repositories: { fixture: { path: repo, allowedPaths: ["src/"], protectedPaths: ["test/"] } }, verificationProfiles: { regression: [{ id: "regression", command: process.execPath, args: ["--test", "--test-reporter=tap", "test/page.test.mjs"], criteria: ["A1"], timeoutMs: 10000 }] }, maxRetries: 2, maxDurationMs: 30000, ...overrides };
  return { root, repo, data, policy };
}
export function adapters(options: { execute?: CodeExecutor["execute"]; review?: Reviewer["review"] } = {}): RuntimeAdapters {
  return { executor: { kind: "fixture", family: "fixture-writer", execute: options.execute ?? (async r => { writeFileSync(path.join(r.workspace, "src/page.mjs"), fixed); return { stopped: true, runId: "fixture-write" }; }) }, reviewer: { kind: "fixture", family: "fixture-reviewer", review: options.review ?? (async r => ({ snapshotId: r.snapshotId, reviewerId: "fixture-reviewer", provider: "fixture", model: "fixture-only-not-a-model", findings: [] })) } };
}
export async function runCase(setup: (f: ReturnType<typeof fixture>) => RuntimeAdapters = () => adapters()) {
  const f = fixture(), runtime = new Devkit(f.policy, setup(f));
  const task = runtime.create(input); const result = await runtime.run(task.taskId);
  return { ...f, runtime, task, result };
}

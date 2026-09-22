import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPaginationFixturePolicy, byteHash, Devkit, git, validateHostPolicy, validateTaskInput, type ExecutionRequest, type HostPolicy } from "../src/index.js";
import { adapters, fixture, fixed, input } from "./helpers.js";

const ref = "invalid-page-overlay";
const target = "test/host-regression.test.mjs";
const marker = "HOST_OVERLAY_INVALID_PAGE_FAILURE";
const source = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import {normalizePage} from '../src/page.mjs';",
  "test('host regression overlay invalid page',()=>{assert.equal(normalizePage(0),1,'HOST_OVERLAY_INVALID_PAGE_FAILURE');});",
  "",
].join("\n");

function overlayPolicy(f: ReturnType<typeof fixture>, sourcePath: string, overrides: Partial<{ target: string; marker: string; profile: string }> = {}): HostPolicy {
  const profile = overrides.profile ?? "overlay-regression";
  return {
    ...f.policy,
    repositories: {
      fixture: {
        ...f.policy.repositories.fixture!,
        regressionOverlays: {
          [ref]: {
            source: sourcePath,
            target: overrides.target ?? target,
            verificationProfile: profile,
            baselineFailureMarker: overrides.marker ?? marker,
          },
        },
      },
    },
    verificationProfiles: {
      [profile]: [{
        id: "overlay-regression",
        command: process.execPath,
        args: ["--test", "--test-reporter=tap", "test/page.test.mjs", overrides.target ?? target],
        criteria: ["A1"],
        timeoutMs: 10000,
      }],
    },
  };
}

function overlayInput(profile = "overlay-regression") {
  return { ...input, verificationProfile: profile, regressionOverlayRefs: [ref] };
}

function hostSource(f: ReturnType<typeof fixture>, content = source): string {
  const root = path.join(f.root, "host-regression-overlays");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "invalid-page.test.mjs");
  writeFileSync(file, content);
  return file;
}

test("regression overlay references are bounded, host-authorized, and excluded from the native fixture", async () => {
  assert.deepEqual(validateTaskInput({ ...input, regressionOverlayRefs: ["z", "a"] }).regressionOverlayRefs, ["a", "z"]);
  for (const regressionOverlayRefs of [["../escape"], ["not/slash"], [ref, ref], ["with\nnewline"]]) {
    assert.throws(() => validateTaskInput({ ...input, regressionOverlayRefs }), /REGRESSION_OVERLAY_REFERENCE|DUPLICATE_REGRESSION_OVERLAY_REFERENCE/);
  }

  const f = fixture(), sourcePath = hostSource(f), policy = overlayPolicy(f, sourcePath);
  assert.throws(() => assertPaginationFixturePolicy(policy), /FIXTURE_REPOSITORY_POLICY_INVALID/);
  const unknownProfile = JSON.parse(JSON.stringify(policy)) as { repositories: { fixture: { regressionOverlays: Record<string, { verificationProfile: string }> } } };
  unknownProfile.repositories.fixture.regressionOverlays[ref]!.verificationProfile = "missing";
  assert.throws(() => validateHostPolicy(unknownProfile), /REGRESSION_OVERLAY_PROFILE_UNKNOWN/);

  const runtime = new Devkit(policy, adapters());
  try {
    assert.throws(() => runtime.create({ ...overlayInput(), regressionOverlayRefs: ["not-configured"] }), /REGRESSION_OVERLAY_NOT_AUTHORIZED/);
  } finally {
    await runtime.close();
  }
});

test("a host regression overlay is frozen privately, proves its own baseline marker, and never enters the delivery patch", async () => {
  const f = fixture(), sourcePath = hostSource(f);
  const policy = overlayPolicy(f, sourcePath);
  // This deliberately overlaps allowed/protected scope to prove export still
  // removes the host-mounted untracked test from its rebuilt Git index.
  policy.repositories.fixture!.allowedPaths = ["src/", "test/"];
  let observed: ExecutionRequest | undefined;
  const runtime = new Devkit(policy, adapters({
    execute: async request => {
      observed = request;
      assert.equal(readFileSync(path.join(request.workspace, target), "utf8"), source);
      writeFileSync(path.join(request.workspace, "src", "page.mjs"), fixed);
      // A writer-controlled index must not smuggle the host-mounted test into
      // the emitted patch after the worktree itself remains frozen.
      git(request.workspace, ["add", "--", target]);
      return { stopped: true, runId: "overlay-fixture" };
    },
  }));
  try {
    const task = runtime.create(overlayInput());
    const frozen = task.frozenRegressionOverlay;
    assert.ok(frozen);
    assert.deepEqual(frozen.files, [{
      ref,
      target,
      hash: byteHash(source),
      size: Buffer.byteLength(source),
      baselineFailureMarkerHash: byteHash(marker),
    }]);
    assert.equal(JSON.stringify(task).includes(source), false);
    assert.equal(JSON.stringify(task).includes(marker), false);
    const artifact = path.join(f.data, "regression-overlays", `${frozen.manifestHash}.json`);
    assert.equal(existsSync(artifact), true);
    assert.equal(statSync(path.join(f.data, "regression-overlays")).mode & 0o777, 0o700);
    assert.equal(statSync(artifact).mode & 0o777, 0o600);
    assert.equal((JSON.parse(readFileSync(artifact, "utf8")) as { files: Array<{ content: string }> }).files[0]?.content, source);

    writeFileSync(sourcePath, "export const changedAfterTaskCreation = true;\n");
    const result = await runtime.run(task.taskId);
    assert.equal(result.status, "awaiting_human");
    assert.equal(result.reason, "final_acceptance");
    assert.equal(observed?.snapshot.files.some(file => file.path === target), true);

    const loaded = runtime.store.history(task.taskId).find(event => event.type === "regression_overlay_loaded");
    assert.ok(loaded);
    assert.equal(JSON.stringify(loaded.payload).includes(source), false);
    assert.deepEqual((loaded.payload as { files: unknown }).files, frozen.files);
    const artifactEvent = runtime.store.history(task.taskId).find(event => event.type === "artifact");
    const artifactPath = (artifactEvent?.payload as { path?: string } | undefined)?.path;
    assert.ok(artifactPath);
    const patch = readFileSync(path.join(f.data, "artifacts", artifactPath), "utf8");
    assert.match(patch, /src\/page\.mjs/);
    assert.equal(patch.includes(target), false);
    assert.equal(patch.includes("HOST_OVERLAY_INVALID_PAGE_FAILURE"), false);
  } finally {
    await runtime.close();
  }
});

test("an overlay blocks before a writer on corrupt bytes or a missing baseline failure marker", async () => {
  const corrupt = fixture(), corruptSource = hostSource(corrupt);
  let corruptExecutions = 0;
  const corruptRuntime = new Devkit(overlayPolicy(corrupt, corruptSource), adapters({
    execute: async () => { corruptExecutions += 1; return { stopped: true, runId: "should-not-run" }; },
  }));
  try {
    const task = corruptRuntime.create(overlayInput());
    const frozen = task.frozenRegressionOverlay;
    assert.ok(frozen);
    writeFileSync(path.join(corrupt.data, "regression-overlays", `${frozen.manifestHash}.json`), "not json");
    const result = await corruptRuntime.run(task.taskId);
    assert.equal(result.reason, "REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
    assert.equal(corruptExecutions, 0);
    assert.equal(corruptRuntime.store.history(task.taskId).some(event => event.type === "executor_dispatch"), false);
  } finally {
    await corruptRuntime.close();
  }

  const missing = fixture(), missingSource = hostSource(missing);
  let missingExecutions = 0;
  const missingRuntime = new Devkit(overlayPolicy(missing, missingSource, { marker: "HOST_OVERLAY_MARKER_THAT_IS_NOT_EMITTED" }), adapters({
    execute: async () => { missingExecutions += 1; return { stopped: true, runId: "should-not-run" }; },
  }));
  try {
    const task = missingRuntime.create(overlayInput());
    const result = await missingRuntime.run(task.taskId);
    assert.equal(result.reason, "REGRESSION_OVERLAY_NOT_REPRODUCED");
    assert.equal(missingExecutions, 0);
  } finally {
    await missingRuntime.close();
  }
});

test("overlay sources stay outside the repository/control plane, targets must be new protected files, and candidates cannot change them", async () => {
  const sourceInsideRepository = fixture();
  assert.throws(() => new Devkit(overlayPolicy(sourceInsideRepository, path.join(sourceInsideRepository.repo, "test", "page.test.mjs")), adapters()), /REGRESSION_OVERLAY_SOURCE_INSIDE_REPOSITORY/);

  const sourceInsideControlPlane = fixture();
  mkdirSync(sourceInsideControlPlane.data, { recursive: true });
  const controlFile = path.join(sourceInsideControlPlane.data, "host-regression.test.mjs");
  writeFileSync(controlFile, source);
  assert.throws(() => new Devkit(overlayPolicy(sourceInsideControlPlane, controlFile), adapters()), /REGRESSION_OVERLAY_SOURCE_INSIDE_CONTROL_PLANE/);

  const unprotected = fixture(), unprotectedSource = hostSource(unprotected);
  assert.throws(() => new Devkit(overlayPolicy(unprotected, unprotectedSource, { target: "src/host-regression.test.mjs" }), adapters()), /REGRESSION_OVERLAY_TARGET_NOT_PROTECTED/);

  const existing = fixture(), existingSource = hostSource(existing);
  const existingRuntime = new Devkit(overlayPolicy(existing, existingSource, { target: "test/page.test.mjs" }), adapters());
  try {
    assert.throws(() => existingRuntime.create(overlayInput()), /REGRESSION_OVERLAY_TARGET_EXISTS/);
  } finally {
    await existingRuntime.close();
  }

  const tampered = fixture(), tamperedSource = hostSource(tampered);
  const tamperedRuntime = new Devkit(overlayPolicy(tampered, tamperedSource), adapters({
    execute: async request => {
      writeFileSync(path.join(request.workspace, "src", "page.mjs"), fixed);
      writeFileSync(path.join(request.workspace, target), "tampered overlay\n");
      return { stopped: true, runId: "tampered-overlay" };
    },
  }));
  try {
    const result = await tamperedRuntime.run(tamperedRuntime.create(overlayInput()).taskId);
    assert.equal(result.reason, "FROZEN_TESTS_CHANGED");
    assert.equal(result.readyForAcceptance, false);
  } finally {
    await tamperedRuntime.close();
  }
});

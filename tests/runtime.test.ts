import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPaginationFixturePolicy, createPaginationFixtureAdapters, Devkit, TaskStore, validateHostPolicy, validateTaskInput, resolveWithin, resolveRealWithin, hash, snapshot, runCommand, minimalEnvironment, redact, evidenceGate, DeepSeekReviewer, git, MacosSeatbeltAppServerConfinement, MacosSeatbeltCommandConfinement, seatbeltProfile, seatbeltReadRestrictedProfile } from "../src/index.js";
import { input, fixture, fixed, broken, adapters, finding, runCase } from "./helpers.js";

test("strict contracts reject nested unknowns, duplicate ids and model permissions", () => {
  for (const patch of [{ approved: true }, { executionMode: "fixture" }, { title: " " }, { reproduction: { ...input.reproduction, approved: true } }, { reproduction: { ...input.reproduction, steps: [1] } }, { acceptanceCriteria: [input.acceptanceCriteria[0], input.acceptanceCriteria[0]] }]) assert.throws(() => validateTaskInput({ ...input, ...patch }));
  assert.throws(() => validateTaskInput({ ...input, kind: "ui-fix" }), /UNSUPPORTED/);
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
test("the native deterministic fixture rejects a loose repository or command policy", () => {
  const f = fixture();
  assert.doesNotThrow(() => assertPaginationFixturePolicy(f.policy));
  const { fixtureDriver: _fixtureDriver, ...missingFixtureDriver } = f.policy;
  assert.throws(() => validateHostPolicy(missingFixtureDriver), /INVALID_FIXTURE_DRIVER/);
  assert.throws(() => validateHostPolicy({ ...f.policy, executionMode: "disabled", fixtureDriver: "pagination-v1" }), /INVALID_FIXTURE_DRIVER/);
  const arbitraryCommand = {
    ...f.policy,
    verificationProfiles: {
      ...f.policy.verificationProfiles,
      regression: [{ ...f.policy.verificationProfiles.regression![0]!, args: ["-e", "process.exit(0)"] }],
    },
  };
  assert.throws(() => assertPaginationFixturePolicy(arbitraryCommand), /FIXTURE_VERIFICATION_POLICY_INVALID/);
  writeFileSync(path.join(f.repo, "src/page.mjs"), "export const arbitrary = true;\n");
  assert.throws(() => assertPaginationFixturePolicy(f.policy), /FIXTURE_SOURCE_UNEXPECTED/);
});
test("trusted reviewer policy stores only a constrained credential reference", () => {
  const f = fixture();
  const { fixtureDriver: _fixtureDriver, ...disabledPolicy } = f.policy;
  const reviewer = { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-review", credentialEnv: "DSH_DEVKIT_REVIEWER_API_KEY", timeoutMs: 45000 };
  assert.deepEqual(validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", reviewer }).reviewer, reviewer);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", reviewer: { ...reviewer, credentialEnv: "PATH" } }), /INVALID_REVIEW_CREDENTIAL_ENV/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", reviewer: { ...reviewer, endpoint: "http://example.invalid/chat/completions" } }), /INVALID_REVIEW_ENDPOINT/);
  assert.throws(() => validateHostPolicy({ ...f.policy, reviewer }), /LIVE_REVIEWER_NOT_ALLOWED_IN_FIXTURE/);
});
test("trusted App Server policy can only request the managed Seatbelt boundary outside fixtures", () => {
  const f = fixture();
  const { fixtureDriver: _fixtureDriver, ...disabledPolicy } = f.policy;
  const protectedRoot = path.join(f.root, "protected");
  mkdirSync(protectedRoot);
  const codexAppServer = { mode: "macos-seatbelt-v1", deniedReadRoots: [protectedRoot] };
  assert.deepEqual(validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexAppServer }).codexAppServer, codexAppServer);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexAppServer: { ...codexAppServer, mode: "anything" } }), /INVALID_APP_SERVER_BOUNDARY/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexAppServer: { ...codexAppServer, deniedReadRoots: ["relative"] } }), /INVALID_APP_SERVER_BOUNDARY/);
  assert.throws(() => validateHostPolicy({ ...f.policy, codexAppServer }), /LIVE_APP_SERVER_BOUNDARY_NOT_ALLOWED_IN_FIXTURE/);
});
test("trusted local approval control-plane policy holds only an environment reference outside fixtures", () => {
  const f = fixture();
  const { fixtureDriver: _fixtureDriver, ...disabledPolicy } = f.policy;
  const codexApprovalControlPlane = {
    mode: "loopback-v1" as const,
    credentialEnv: "DSH_DEVKIT_APPROVAL_CONTROL_SECRET",
    operatorId: "local-operator",
    port: 0,
  };
  assert.deepEqual(
    validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexApprovalControlPlane }).codexApprovalControlPlane,
    codexApprovalControlPlane,
  );
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexApprovalControlPlane: { ...codexApprovalControlPlane, credentialEnv: "PATH" } }), /INVALID_APPROVAL_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexApprovalControlPlane: { ...codexApprovalControlPlane, operatorId: "bad operator" } }), /INVALID_APPROVAL_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", codexApprovalControlPlane: { ...codexApprovalControlPlane, port: -1 } }), /INVALID_APPROVAL_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...f.policy, codexApprovalControlPlane }), /LIVE_APPROVAL_CONTROL_PLANE_NOT_ALLOWED_IN_FIXTURE/);
});
test("trusted recovery control-plane policy holds only an environment reference outside fixtures", () => {
  const f = fixture();
  const { fixtureDriver: _fixtureDriver, ...disabledPolicy } = f.policy;
  const recoveryControlPlane = {
    mode: "loopback-v1" as const,
    credentialEnv: "DSH_DEVKIT_RECOVERY_CONTROL_SECRET",
    operatorId: "local-operator",
    port: 0,
  };
  assert.deepEqual(
    validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", recoveryControlPlane }).recoveryControlPlane,
    recoveryControlPlane,
  );
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", recoveryControlPlane: { ...recoveryControlPlane, credentialEnv: "PATH" } }), /INVALID_RECOVERY_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", recoveryControlPlane: { ...recoveryControlPlane, operatorId: "bad operator" } }), /INVALID_RECOVERY_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...disabledPolicy, executionMode: "disabled", recoveryControlPlane: { ...recoveryControlPlane, port: -1 } }), /INVALID_RECOVERY_CONTROL_PLANE/);
  assert.throws(() => validateHostPolicy({ ...f.policy, recoveryControlPlane }), /LIVE_RECOVERY_CONTROL_PLANE_NOT_ALLOWED_IN_FIXTURE/);
  assert.throws(() => assertPaginationFixturePolicy({ ...f.policy, recoveryControlPlane }), /FIXTURE_REPOSITORY_POLICY_INVALID/);
});
test("the deterministic native fixture guards the cloned base before it runs a command", async () => {
  const f = fixture();
  const runtime = new Devkit(f.policy, createPaginationFixtureAdapters());
  try {
    writeFileSync(path.join(f.repo, "src/page.mjs"), "export const arbitrary = true;\n");
    git(f.repo, ["add", "src/page.mjs"]);
    git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unsafe fixture base"]);
    const task = runtime.create({ ...input, baseRef: "HEAD" });
    const result = await runtime.run(task.taskId);
    assert.equal(result.reason, "FIXTURE_SOURCE_UNEXPECTED");
    assert.ok(runtime.store.history(task.taskId).some((event) => event.type === "workspace_created"));
    assert.equal(runtime.store.history(task.taskId).some((event) => event.type === "reproduction"), false);
  } finally { await runtime.close(); }
});
test("idempotency, policy conflicts and compare-and-swap are durable", () => {
  const f = fixture(), store = new TaskStore(path.join(f.data, "tasks.sqlite"));
  const value = validateTaskInput({ ...input, idempotencyKey: "request-1" }), a = store.create(value, "policy");
  assert.equal(store.create(value, "policy").taskId, a.taskId);
  assert.throws(() => store.create({ ...value, title: "different" }, "policy"), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => store.create(value, "changed-policy"), /IDEMPOTENCY_CONFLICT/);
  store.update(a.taskId, a.version, { status: "cancelled" }, "cancelled");
  assert.throws(() => store.update(a.taskId, 0, {}, "bad"), /VERSION_CONFLICT/);
  store.close(); const reopened = new TaskStore(path.join(f.data, "tasks.sqlite"));
  assert.equal(reopened.get(a.taskId).status, "cancelled"); assert.equal(reopened.history(a.taskId).length, 2); reopened.close();
});
test("failed event write rolls back the state update", () => {
  const f = fixture(), dbPath = path.join(f.data, "tasks.sqlite"), store = new TaskStore(dbPath), a = store.create(validateTaskInput(input), "p");
  const db = new DatabaseSync(dbPath); db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.type='bad' BEGIN SELECT RAISE(ABORT,'event rejected'); END;");
  assert.throws(() => store.update(a.taskId, 0, { status: "cancelled" }, "bad"), /event rejected/);
  assert.equal(store.get(a.taskId).status, "queued"); assert.equal(store.history(a.taskId).length, 1); db.close(); store.close();
});
test("store restart interrupts an unfinished writer, retains its lease, and prevents a second writer", () => {
  const f = fixture(), name = path.join(f.data, "tasks.sqlite"), a = new TaskStore(name), task1 = a.create(validateTaskInput(input), "p"), task2 = a.create(validateTaskInput(input), "p");
  a.acquire(task1.taskId, "repo", "run-1"); a.close();
  const b = new TaskStore(name);
  assert.equal(b.get(task1.taskId).status, "interrupted");
  assert.equal(b.get(task1.taskId).reason, "restart_requires_reconciliation");
  assert.deepEqual(b.lease(task1.taskId), { resource: "repo", runId: "run-1", acquiredAt: b.lease(task1.taskId)!.acquiredAt });
  assert.ok(b.history(task1.taskId).some((event) => event.type === "runtime_restarted" && (event.payload as { leaseRetained?: boolean }).leaseRetained === true));
  assert.throws(() => b.acquire(task2.taskId, "repo", "run-2"), /WORKSPACE_BUSY/);
  b.release(task1.taskId, "wrong-owner"); assert.equal(b.hasLease(task1.taskId), true); b.close();
});
test("unsupported migrations and corrupt stores preserve original bytes", () => {
  const f = fixture(); mkdirSync(f.data); const name = path.join(f.data, "tasks.sqlite"), db = new DatabaseSync(name); db.exec("PRAGMA user_version=99"); db.close();
  const before = readFileSync(name); assert.throws(() => new TaskStore(name), /STORE_SCHEMA_UNSUPPORTED/); assert.deepEqual(readFileSync(name), before);
  writeFileSync(name, "not a database"); assert.throws(() => new TaskStore(name)); assert.equal(readFileSync(name, "utf8"), "not a database");
});
test("malformed persisted rows fail closed instead of bypassing SQLite unknown types", () => {
  const f = fixture(), name = path.join(f.data, "tasks.sqlite"), store = new TaskStore(name), task = store.create(validateTaskInput(input), "policy");
  store.close();
  const db = new DatabaseSync(name); db.prepare("UPDATE tasks SET record=? WHERE id=?").run("not-json", task.taskId); db.close();
  const reopened = new TaskStore(name); try { assert.throws(() => reopened.get(task.taskId), /STORE_CORRUPT/); } finally { reopened.close(); }
});
test("path checks reject traversal, prefix collisions, Windows paths and symlink parents", () => {
  const f = fixture(); for (const value of ["../repo2/file", "/etc/passwd", "C:\\secret", "C:secret", "\\\\host\\share", "src\\..\\file"]) assert.throws(() => resolveWithin(f.repo, value), /PATH_OUTSIDE/);
  symlinkSync(f.root, path.join(f.repo, "escape")); assert.throws(() => resolveRealWithin(f.repo, "escape/new-file"), /SYMLINK/);
  symlinkSync(path.join(f.root, "missing"), path.join(f.repo, "dangling")); assert.throws(() => resolveRealWithin(f.repo, "dangling/new"), /SYMLINK/);
});
test("Seatbelt command confinement builds a narrow profile and never falls back when its runner is unavailable", async () => {
  const f = fixture();
  const protectedRoot = path.join(f.root, "protected");
  mkdirSync(protectedRoot);
  const profile = seatbeltProfile({ writableRoots: [f.repo], deniedReadRoots: [protectedRoot] });
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(deny file-read\*/);
  assert.match(profile, /\(deny network\*\)/);
  assert.throws(() => seatbeltProfile({ writableRoots: [f.repo], deniedReadRoots: [f.root] }), /SANDBOX_ROOTS_OVERLAP/);
  const readRestricted = seatbeltReadRestrictedProfile({
    writableRoots: [f.repo],
    deniedReadRoots: [protectedRoot],
    ambientDeniedReadRoots: [f.root],
    allowedReadRoots: [f.repo],
  });
  assert.match(readRestricted, /\(deny file-read\*/);
  assert.match(readRestricted, /\(allow file-read\*/);
  assert.throws(() => seatbeltReadRestrictedProfile({
    writableRoots: [f.repo],
    deniedReadRoots: [protectedRoot],
    ambientDeniedReadRoots: [f.root],
    allowedReadRoots: [protectedRoot],
  }), /SANDBOX_ROOTS_OVERLAP/);

  const unavailable = new MacosSeatbeltCommandConfinement({
    deniedReadRoots: [protectedRoot],
    sandboxExec: path.join(f.root, "missing-sandbox-exec"),
  });
  const status = await unavailable.status();
  assert.deepEqual(status, {
    state: "unsupported", mechanism: "macos-seatbelt", platform: process.platform,
    enforcement: "none", filesystem: "none", network: "none", credentialReads: "none",
    reason: process.platform === "darwin" ? "SANDBOX_EXEC_UNAVAILABLE" : "MACOS_SEATBELT_REQUIRES_DARWIN",
  });
  await assert.rejects(unavailable.prepare([process.execPath, "--version"], f.repo, new AbortController().signal), /SANDBOX_UNAVAILABLE/);
});
test("Seatbelt App Server boundary requires async preflight, an exact provider launch, and managed-range proof", async () => {
  const f = fixture();
  const protectedRoot = path.join(f.root, "protected");
  mkdirSync(protectedRoot);
  const inheritedName = "DEVKIT_APP_SERVER_PARENT_INJECTION_TEST";
  const priorInherited = process.env[inheritedName];
  process.env[inheritedName] = "must-not-reach-app-server";
  let captured: { argv: readonly string[]; env: NodeJS.ProcessEnv | undefined } | undefined;
  let rangeExited = false;
  try {
    const boundary = new MacosSeatbeltAppServerConfinement({
      subprocess: {
        spawn(spec) {
          captured = { argv: spec.argv, env: spec.env };
          return {
            stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: Promise.resolve({}),
            terminate() {}, async waitForExit() { return rangeExited; },
          };
        },
      },
      deniedReadRoots: [protectedRoot],
      sandboxExec: path.join(f.root, "sandbox-exec"),
      status: async () => ({
        state: "supported", mechanism: "macos-seatbelt", platform: "darwin", enforcement: "full", filesystem: "full", network: "full", credentialReads: "configured-roots",
        probe: { workspaceWriteAllowed: true, controlWriteDenied: true, protectedReadDenied: true, networkDenied: true, unixSocketDenied: true },
      }),
    });
    const wrapper = path.join(f.root, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(path.dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, "// fake package-local wrapper\n");
    const request = {
      argv: [process.execPath, wrapper, "app-server", "--stdio"], cwd: f.repo,
      stdio: { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const }, graceMs: 3000, env: {},
    };
    assert.throws(() => boundary.spawn(request), /APP_SERVER_BOUNDARY_NOT_PREPARED/);
    const prepared = await boundary.prepare(f.repo, new AbortController().signal);
    const lookalike = path.join(f.root, "lookalike", "@openai", "codex", "bin", "codex.js");
    mkdirSync(path.dirname(lookalike), { recursive: true });
    writeFileSync(lookalike, "// not installed below node_modules\n");
    assert.throws(() => boundary.spawn({ ...request, argv: [process.execPath, lookalike, "app-server", "--stdio"] }), /APP_SERVER_BOUNDARY_REQUEST_REJECTED/);
    const child = boundary.spawn(request);
    assert.equal(captured?.argv[0], path.join(f.root, "sandbox-exec"));
    assert.match(String(captured?.argv[2]), /\(deny network\*\)/);
    assert.equal(captured?.argv.at(-1), "--stdio");
    const temporary = captured?.env?.TMPDIR;
    assert.equal(typeof temporary, "string");
    assert.equal(captured?.env?.HOME, temporary);
    assert.equal(captured?.env?.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(captured?.env?.[inheritedName], undefined);
    assert.equal(Object.hasOwn(captured?.env ?? {}, inheritedName), true, "the explicit tombstone must override DSH's scrubbed parent base");
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"]) {
      assert.equal(captured?.env?.[name], undefined);
      assert.equal(Object.hasOwn(captured?.env ?? {}, name), true, `the DSH proxy overlay ${name} must be tombstoned`);
    }
    assert.equal(existsSync(temporary!), true);
    assert.throws(() => boundary.spawn(request), /APP_SERVER_BOUNDARY_ALREADY_SPAWNED/);
    assert.equal(await prepared.release(true), false, "a provider result alone cannot prove its managed range is empty");
    rangeExited = true;
    assert.equal(await child.waitForExit(), true);
    assert.equal(await prepared.release(true), true);
    assert.equal(existsSync(temporary!), false);
  } finally {
    if (priorInherited === undefined) delete process.env[inheritedName];
    else process.env[inheritedName] = priorInherited;
  }
});
test("snapshots cover untracked binary content, executable mode and policy changes", () => {
  const f = fixture(), a = snapshot(f.repo, "base", "policy", "plan"); writeFileSync(path.join(f.repo, "src/binary"), Buffer.from([0, 255, 1]));
  const b = snapshot(f.repo, "base", "policy", "plan"); assert.notEqual(a.id, b.id); chmodSync(path.join(f.repo, "src/binary"), 0o755);
  assert.notEqual(b.id, snapshot(f.repo, "base", "policy", "plan").id); assert.notEqual(b.id, snapshot(f.repo, "base", "new", "plan").id);
});
test("fixture performs real regression, patch delivery and host-only acceptance", async () => {
  const f = fixture(); writeFileSync(path.join(f.repo, "dirty.txt"), "user edit"); const before = git(f.repo, ["status", "--porcelain"]);
  const runtime = new Devkit(f.policy, adapters()); try {
    const result = await runtime.run(runtime.create(input).taskId);
    assert.equal(result.status, "awaiting_human"); assert.equal(result.reason, "final_acceptance"); assert.equal(result.readyForAcceptance, true);
    assert.equal(git(f.repo, ["status", "--porcelain"]), before); assert.equal(readFileSync(path.join(f.repo, "src/page.mjs"), "utf8"), broken);
    const events = runtime.store.history(result.taskId); assert.ok(events.some(e => e.type === "reproduction")); assert.ok(events.some(e => e.type === "verification")); assert.ok(events.some(e => e.type === "review"));
    const patch = readFileSync(path.join(f.data, "artifacts", result.taskId, "changes.patch"), "utf8"); assert.match(patch, /Number.isInteger/);
    assert.equal(runtime.accept(result.taskId, result.snapshotId!, "trusted-local-test-operator").status, "completed");
  } finally { await runtime.close(); }
});
test("a changed candidate invalidates final acceptance", async () => {
  const f = await runCase(); try { writeFileSync(path.join(f.result.workspace!, "src/page.mjs"), broken); assert.throws(() => f.runtime.accept(f.task.taskId, f.result.snapshotId!, "operator"), /STALE_SNAPSHOT/); } finally { await f.runtime.close(); }
});
test("no reproduction does not dispatch the writer", async () => {
  const f = fixture(); writeFileSync(path.join(f.repo, "src/page.mjs"), fixed); git(f.repo, ["add", "."]); git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "already fixed"]);
  let calls = 0; const runtime = new Devkit(f.policy, adapters({ execute: async () => { calls++; return { stopped: true, runId: "never" }; } }));
  try { const r = await runtime.run(runtime.create(input).taskId); assert.equal(r.reason, "NOT_REPRODUCED"); assert.equal(calls, 0); } finally { await runtime.close(); }
});
test("default policy blocks live before any model execution", async () => {
  const f = fixture();
  const { fixtureDriver: _fixtureDriver, ...disabledPolicy } = f.policy;
  const runtime = new Devkit({ ...disabledPolicy, executionMode: "disabled" }, adapters());
  try { const r = await runtime.run(runtime.create(input).taskId); assert.equal(r.reason, "LIVE_SANDBOX_NOT_IMPLEMENTED"); assert.equal(r.workspace, undefined); } finally { await runtime.close(); }
});
test("missing reviewer and same-family reviewer fail closed", async () => {
  for (const same of [false, true]) { const f = fixture(), a = adapters(); if (same) a.reviewer = { ...a.reviewer!, family: "fixture-writer" }; else delete a.reviewer;
    const runtime = new Devkit(f.policy, a); try { const r = await runtime.run(runtime.create(input).taskId); assert.equal(r.reason, same ? "INDEPENDENT_REVIEW_REQUIRED" : "EXECUTOR_OR_REVIEWER_MISSING"); } finally { await runtime.close(); }
  }
});
test("a stopped executor failure is recorded and releases the writer lease", async () => {
  const f = fixture(), runtime = new Devkit(f.policy, adapters({ execute: async () => ({ stopped: true, runId: "codex-run", failure: "CODEX_SUBAGENT_ERROR" }) }));
  try {
    const task = runtime.create(input), result = await runtime.run(task.taskId);
    assert.equal(result.status, "blocked"); assert.equal(result.reason, "CODEX_SUBAGENT_ERROR"); assert.equal(runtime.store.hasLease(task.taskId), false);
    const event = runtime.store.history(task.taskId).find((item) => item.type === "executor_settled");
    assert.deepEqual(event?.payload, { stopped: true, runId: "codex-run", failure: "CODEX_SUBAGENT_ERROR" });
  } finally { await runtime.close(); }
});
test("frozen test modification and out-of-scope changes cannot pass", async () => {
  for (const file of ["test/page.test.mjs", "unauthorized.txt"]) { const f = await runCase(() => adapters({ execute: async r => { writeFileSync(path.join(r.workspace, file), "tampered"); return { stopped: true, runId: "fixture" }; } }));
    try { assert.equal(f.result.readyForAcceptance, false); assert.equal(f.result.reason, file.startsWith("test/") ? "FROZEN_TESTS_CHANGED" : "OUT_OF_SCOPE_CHANGE"); } finally { await f.runtime.close(); }
  }
});
test("failed tests share a finite durable retry budget", async () => {
  let calls = 0; const f = await runCase(() => adapters({ execute: async () => { calls++; return { stopped: true, runId: "unfixed" }; } }));
  try { assert.equal(calls, 3); assert.equal(f.result.retryCount, 2); assert.equal(f.result.reason, "retry_limit"); assert.equal(f.result.readyForAcceptance, false); assert.throws(() => f.runtime.resume(f.task.taskId), /RECOVERY_REQUIRES_OPERATOR/); assert.equal(f.runtime.status(f.task.taskId).retryCount, 2); } finally { await f.runtime.close(); }
});
test("host-authorized recovery preserves an interrupted candidate and retries only from a fresh clone", async () => {
  const f = fixture();
  let interruptedWorkspace = "";
  let inspectedWorkspaceState: string | undefined;
  const interrupted = new Devkit(f.policy, {
    ...adapters({ execute: async request => {
      interruptedWorkspace = request.workspace;
      writeFileSync(path.join(request.workspace, "src/page.mjs"), fixed);
      return { stopped: false, runId: "writer-without-stop-proof" };
    } }),
    recoveryAuthority: {
      async authorizeRecovery(inspection) {
        inspectedWorkspaceState = inspection.workspaceState;
        return {
          action: "retry-from-base",
          taskId: inspection.task.taskId,
          runId: inspection.lease.runId,
          fingerprint: inspection.fingerprint,
          approvalId: "fixture-operator-recovery-approval",
          oldWriterStopped: true,
        };
      },
    },
  });
  const task = interrupted.create(input);
  try {
    const first = await interrupted.run(task.taskId);
    assert.equal(first.status, "interrupted");
    assert.equal(interrupted.store.hasLease(task.taskId), true);
    const inspection = interrupted.resume(task.taskId);
    assert.equal(inspection.workspaceState, "changed", "a partial writer result is never reused in place");
    assert.equal(inspection.expectedSnapshotId === inspection.observedSnapshotId, false);
    const requeued = await interrupted.recover(task.taskId);
    assert.equal(inspectedWorkspaceState, "changed");
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.workspace, undefined);
    assert.equal(requeued.snapshotId, undefined);
    assert.equal(requeued.runId, undefined);
    assert.equal(requeued.retryCount, 0);
    assert.equal(interrupted.store.hasLease(task.taskId), false);
    assert.equal(existsSync(interruptedWorkspace), true, "recovery retains the interrupted candidate for human inspection");
    const recoveryEvent = interrupted.store.history(task.taskId).find((event) => event.type === "recovery_requeued");
    assert.equal(JSON.stringify(recoveryEvent?.payload).includes("fixture-operator-recovery-approval"), false, "task history must retain an approval audit hash, not a raw approval artifact");
  } finally {
    await interrupted.close();
  }
  const resumed = new Devkit(f.policy, adapters());
  try {
    const final = await resumed.run(task.taskId);
    assert.equal(final.readyForAcceptance, true);
    assert.notEqual(final.workspace, interruptedWorkspace, "the fresh attempt must not reuse the interrupted workspace");
    assert.ok(resumed.store.history(task.taskId).some((event) => event.type === "recovery_requeued"));
  } finally {
    await resumed.close();
  }
});
test("recovery keeps the lease if the workspace changes while an operator decision is pending", async () => {
  const f = fixture();
  const runtime = new Devkit(f.policy, {
    ...adapters({ execute: async () => ({ stopped: false, runId: "writer-without-stop-proof" }) }),
    recoveryAuthority: {
      async authorizeRecovery(inspection) {
        writeFileSync(path.join(inspection.task.workspace!, "src/page.mjs"), fixed);
        return {
          action: "retry-from-base",
          taskId: inspection.task.taskId,
          runId: inspection.lease.runId,
          fingerprint: inspection.fingerprint,
          approvalId: "fixture-stale-recovery-approval",
          oldWriterStopped: true,
        };
      },
    },
  });
  try {
    const task = runtime.create(input);
    assert.equal((await runtime.run(task.taskId)).status, "interrupted");
    await assert.rejects(runtime.recover(task.taskId), /RECOVERY_STATE_CHANGED/);
    assert.equal(runtime.status(task.taskId).status, "interrupted");
    assert.equal(runtime.store.hasLease(task.taskId), true);
  } finally {
    await runtime.close();
  }
});
test("only one host recovery authorization can be pending for a retained task", async () => {
  const f = fixture();
  let signalAuthorizationStarted!: () => void;
  const authorizationStarted = new Promise<void>(resolve => { signalAuthorizationStarted = resolve; });
  let permitRecovery: (() => void) | undefined;
  const runtime = new Devkit(f.policy, {
    ...adapters({ execute: async () => ({ stopped: false, runId: "writer-without-stop-proof" }) }),
    recoveryAuthority: {
      async authorizeRecovery(inspection) {
        return await new Promise(resolve => {
          permitRecovery = () => resolve({
            action: "retry-from-base",
            taskId: inspection.task.taskId,
            runId: inspection.lease.runId,
            fingerprint: inspection.fingerprint,
            approvalId: "fixture-single-pending-recovery-approval",
            oldWriterStopped: true,
          });
          signalAuthorizationStarted();
        });
      },
    },
  });
  let recovery: Promise<import("../src/index.js").TaskRecord> | undefined;
  try {
    const task = runtime.create(input);
    assert.equal((await runtime.run(task.taskId)).status, "interrupted");
    recovery = runtime.recover(task.taskId);
    await authorizationStarted;
    await assert.rejects(runtime.recover(task.taskId), /RECOVERY_ALREADY_PENDING/);
    permitRecovery?.();
    assert.equal((await recovery).status, "queued");
    assert.equal(runtime.store.hasLease(task.taskId), false);
  } finally {
    permitRecovery?.();
    await recovery?.catch(() => undefined);
    await runtime.close();
  }
});
test("unconfirmed P1 requests human judgement without claiming readiness", async () => {
  const f = await runCase(() => adapters({ review: async r => ({ snapshotId: r.snapshotId, reviewerId: "fixture", provider: "fixture", model: "fixture", findings: [finding()] }) }));
  try { assert.equal(f.result.reason, "unconfirmed_high_risk"); assert.equal(f.result.status, "awaiting_human"); assert.equal(f.result.readyForAcceptance, false); } finally { await f.runtime.close(); }
});
test("host-confirmed P1 triggers a fresh validation and review", async () => {
  let reviews = 0; const f = await runCase(() => ({ ...adapters({ review: async r => ({ snapshotId: r.snapshotId, reviewerId: "fixture", provider: "fixture", model: "fixture", findings: reviews++ === 0 ? [finding()] : [] }) }), confirmFinding: async () => true }));
  try { assert.equal(reviews, 2); assert.equal(f.result.retryCount, 1); assert.equal(f.result.readyForAcceptance, true); assert.equal(f.runtime.store.history(f.task.taskId).filter(e => e.type === "review").length, 2); } finally { await f.runtime.close(); }
});
test("low priority findings enter a deduplicated backlog", async () => {
  const f = await runCase(() => adapters({ review: async r => ({ snapshotId: r.snapshotId, reviewerId: "fixture", provider: "fixture", model: "fixture", findings: [finding("P2"), finding("P2")] }) }));
  try { assert.equal(f.result.readyForAcceptance, true); const backlog = f.runtime.store.history(f.task.taskId).find(e => e.type === "backlog")!.payload as { findings: unknown[] }; assert.equal(backlog.findings.length, 1); } finally { await f.runtime.close(); }
});
test("stale or failed review never becomes an empty successful review", async () => {
  for (const bad of [false, true]) { const f = await runCase(() => adapters({ review: async r => { if (bad) throw new Error("review unavailable"); return { snapshotId: "stale", reviewerId: "fixture", provider: "fixture", model: "fixture", findings: [] }; } }));
    try { assert.equal(f.result.status, "blocked"); assert.equal(f.result.readyForAcceptance, false); } finally { await f.runtime.close(); }
  }
});
test("reviewer mutation invalidates the candidate", async () => {
  let work = ""; const f = await runCase(() => adapters({ execute: async r => { work = r.workspace; writeFileSync(path.join(work, "src/page.mjs"), fixed); return { stopped: true, runId: "fixture" }; }, review: async r => { writeFileSync(path.join(work, "src/page.mjs"), broken); return { snapshotId: r.snapshotId, reviewerId: "fixture", provider: "fixture", model: "fixture", findings: [] }; } }));
  try { assert.equal(f.result.reason, "REVIEW_MUTATED_SOURCE"); } finally { await f.runtime.close(); }
});
test("missing command, zero-test success and skipped tests are infrastructure failures", async () => {
  const f = fixture(), signal = new AbortController().signal;
  for (const [command, args] of [["/does-not-exist", []], [process.execPath, ["-e", "console.log('no tests')"]], [process.execPath, ["--test", "--test-reporter=tap", "test/skipped.mjs"]]] as [string, string[]][]) {
    writeFileSync(path.join(f.repo, "test/skipped.mjs"), "import test from 'node:test'; test.skip('not verified',()=>{});\n");
    const r = await runCommand({ id: "check", command, args, criteria: ["A1"], timeoutMs: 3000 }, f.repo, signal); assert.equal(r.classification, "failed_infrastructure");
  }
});
test("command runner preserves argv and filters inherited credentials", async () => {
  const f = fixture(); process.env.DEVKIT_TEST_SECRET = "sensitive";
  const r = await runCommand({ id: "argv", command: process.execPath, args: ["-e", "console.log(JSON.stringify({arg:process.argv[1],secret:process.env.DEVKIT_TEST_SECRET}))", "hello;touch /tmp/no-such-marker"], criteria: [], timeoutMs: 3000 }, f.repo, new AbortController().signal);
  assert.match(r.stdout, /hello;touch/); assert.doesNotMatch(r.stdout, /sensitive/); delete process.env.DEVKIT_TEST_SECRET;
  assert.equal(minimalEnvironment(f.repo).NODE_OPTIONS, undefined); assert.match(redact("api_key=sk-abcdefghijk"), /REDACTED/);
});
test("command runner uses a host-prepared confinement and disposes it after process settlement", async () => {
  const f = fixture();
  writeFileSync(path.join(f.repo, "test", "confined.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('host environment',()=>assert.equal(process.env.DEVKIT_CONFINED,'yes'));\n");
  let observed: { argv: readonly string[]; cwd: string } | undefined;
  let disposals = 0;
  const result = await runCommand({
    id: "confined", command: process.execPath, args: ["--test", "--test-reporter=tap", "test/confined.mjs"], criteria: ["A1"], timeoutMs: 3000,
  }, f.repo, new AbortController().signal, {
    id: "host-test-confinement",
    async prepare(argv, cwd) {
      observed = { argv, cwd };
      return { argv, environment: { DEVKIT_CONFINED: "yes" }, dispose() { disposals += 1; } };
    },
  });
  assert.equal(result.classification, "passed");
  assert.deepEqual(observed, { argv: [process.execPath, "--test", "--test-reporter=tap", "test/confined.mjs"], cwd: f.repo });
  assert.equal(disposals, 1);
});
test("command runner disposes a prepared confinement if setup stops before a child can settle", async () => {
  const f = fixture();
  const spec = { id: "cleanup", command: process.execPath, args: ["--version"], criteria: [], timeoutMs: 3000 };
  const controller = new AbortController();
  let abortedDisposals = 0;
  await assert.rejects(runCommand(spec, f.repo, controller.signal, {
    id: "abort-during-prepare",
    async prepare(argv) {
      controller.abort();
      return { argv, dispose() { abortedDisposals += 1; } };
    },
  }), /CANCELLED/);
  assert.equal(abortedDisposals, 1);

  let spawnDisposals = 0;
  await assert.rejects(runCommand(spec, "\0invalid-cwd", new AbortController().signal, {
    id: "spawn-error",
    async prepare(argv) { return { argv, dispose() { spawnDisposals += 1; } }; },
  }));
  assert.equal(spawnDisposals, 1);
});
test("long-running command cancellation waits for process group settlement", async () => {
  const f = fixture(), controller = new AbortController(); const pending = runCommand({ id: "long", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], criteria: [], timeoutMs: 5000 }, f.repo, controller.signal); setTimeout(() => controller.abort(), 100);
  const r = await pending; assert.equal(r.classification, "cancelled"); assert.equal(r.stopped, true);
});
test("a second run is rejected and cancellation does not claim stopped without proof", async () => {
  let entered!: () => void, settle!: () => void; const started = new Promise<void>(r => { entered = r; }), done = new Promise<void>(r => { settle = r; });
  const f = fixture(), runtime = new Devkit(f.policy, adapters({ execute: async () => { entered(); await done; return { stopped: false, runId: "unconfirmed" }; } }));
  try { const task = runtime.create(input), pending = runtime.run(task.taskId); await started; await assert.rejects(runtime.run(task.taskId), /TASK_ALREADY_RUNNING/); const cancel = runtime.cancel(task.taskId); settle(); await cancel; const r = await pending;
    assert.equal(r.status, "interrupted"); assert.equal(runtime.store.hasLease(task.taskId), true); await assert.rejects(runtime.cancel(task.taskId), /STOP_UNCONFIRMED/);
  } finally { await runtime.close(); }
});
test("evidence from old snapshots or incomplete acceptance mappings is rejected", () => {
  assert.equal(evidenceGate("B", ["A1"], ["check"], [{ checkId: "check", snapshotId: "A", criteria: ["A1"], passed: true }], { snapshotId: "B", passed: true, blockingFindings: 0 }), false);
  assert.equal(evidenceGate("A", ["A1", "A2"], ["check"], [{ checkId: "check", snapshotId: "A", criteria: ["A1"], passed: true }], { snapshotId: "A", passed: true, blockingFindings: 0 }), false);
});
test("DeepSeek HTTP adapter sends read-only JSON context and validates response", async () => {
  let body: Record<string, unknown> = {};
  const reviewer = new DeepSeekReviewer({ endpoint: "https://api.deepseek.com/chat/completions", model: "configured-test-model", credential: () => "test-credential" }, async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>; assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ model: "configured-test-model", choices: [{ message: { content: '{"findings":[]}' } }] }), { status: 200 });
  });
  const r = await reviewer.review({ snapshotId: "snap", task: input, patch: "safe diff", evidence: [], signal: new AbortController().signal });
  assert.equal(r.snapshotId, "snap"); assert.equal(r.findings.length, 0); assert.equal(body.tools, undefined); assert.equal(JSON.stringify(body).includes("test-credential"), false);
  await assert.rejects(reviewer.review({ snapshotId: "snap", task: input, patch: "sk-secret123456789", evidence: [], signal: new AbortController().signal }), /POSSIBLE_SECRET/);
});
test("base commit is frozen when a task is created", async () => {
  const f = fixture(), runtime = new Devkit(f.policy, adapters());
  try { const task = runtime.create(input); writeFileSync(path.join(f.repo, "src/page.mjs"), fixed); git(f.repo, ["add", "."]); git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "advance main"]);
    const result = await runtime.run(task.taskId); assert.equal(result.baseCommit, task.baseCommit); assert.notEqual(result.baseCommit, git(f.repo, ["rev-parse", "HEAD"]).trim()); assert.equal(result.readyForAcceptance, true);
  } finally { await runtime.close(); }
});
test("source mutation by a verification command invalidates the result", async () => {
  const f = fixture(); const file = path.join(f.repo, "test/page.test.mjs");
  writeFileSync(file, readFileSync(file, "utf8") + "\nimport {readFileSync,appendFileSync} from 'node:fs'; if(readFileSync(new URL('../src/page.mjs',import.meta.url),'utf8').includes('Number.isInteger')) appendFileSync(new URL('../src/page.mjs',import.meta.url),'//mutation');\n");
  git(f.repo, ["add", "."]); git(f.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "mutating verifier fixture"]);
  const runtime = new Devkit(f.policy, adapters()); try { const r = await runtime.run(runtime.create(input).taskId); assert.equal(r.reason, "VERIFICATION_MUTATED_SOURCE"); assert.equal(r.readyForAcceptance, false); } finally { await runtime.close(); }
});
test("cooperative cancellation confirms stop before releasing the lease", async () => {
  const f = fixture(); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const runtime = new Devkit(f.policy, adapters({ execute: async r => { entered(); await new Promise<void>(resolve => { if (r.signal.aborted) resolve(); else r.signal.addEventListener("abort", () => resolve(), { once: true }); }); return { stopped: true, runId: "cancelled-fixture" }; } }));
  try { const task = runtime.create(input), pending = runtime.run(task.taskId); await started; const result = await runtime.cancel(task.taskId); await pending; assert.equal(result.status, "cancelled"); assert.equal(runtime.store.hasLease(task.taskId), false); } finally { await runtime.close(); }
});
test("plugin shutdown waits for owned cooperative execution", async () => {
  const f = fixture(); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const runtime = new Devkit(f.policy, adapters({ execute: async r => { entered(); await new Promise<void>(resolve => { if (r.signal.aborted) resolve(); else r.signal.addEventListener("abort", () => resolve(), { once: true }); }); return { stopped: true, runId: "shutdown" }; } }));
  const task = runtime.create(input), pending = runtime.run(task.taskId); await started; await runtime.close(); assert.equal((await pending).status, "cancelled");
  const reopened = new TaskStore(path.join(f.data, "tasks.sqlite")); assert.equal(reopened.get(task.taskId).status, "cancelled"); assert.equal(reopened.hasLease(task.taskId), false); reopened.close();
});
test("persistent confirmed P1 stops at the shared retry limit", async () => {
  let calls = 0; const f = await runCase(() => ({ ...adapters({ review: async r => { calls++; return { snapshotId: r.snapshotId, reviewerId: "fixture", provider: "fixture", model: "fixture", findings: [finding()] }; } }), confirmFinding: async () => true }));
  try { assert.equal(calls, 3); assert.equal(f.result.reason, "retry_limit"); assert.equal(f.result.retryCount, 2); } finally { await f.runtime.close(); }
});
test("DeepSeek malformed JSON and model mismatch cannot be counted as an empty review", async () => {
  for (const response of [{ model: "configured-test-model", choices: [{ message: { content: "not-json" } }] }, { model: "different-model", choices: [{ message: { content: '{"findings":[]}' } }] }]) {
    const reviewer = new DeepSeekReviewer({ endpoint: "https://api.deepseek.com/chat/completions", model: "configured-test-model", credential: () => "fixture" }, async () => new Response(JSON.stringify(response), { status: 200 }));
    await assert.rejects(reviewer.review({ snapshotId: "a", task: input, patch: "diff", evidence: [], signal: new AbortController().signal }));
  }
});

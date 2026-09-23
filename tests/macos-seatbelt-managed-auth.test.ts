import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  DevkitError,
  MacosSeatbeltManagedAuthLaunch,
  PrivateCodexStateRoot,
  type AppServerSubprocessSpec,
} from "../src/index.js";

function supportedCapability() {
  return {
    state: "supported" as const,
    mechanism: "macos-seatbelt" as const,
    platform: "darwin" as const,
    enforcement: "full" as const,
    filesystem: "full" as const,
    network: "full" as const,
    credentialReads: "configured-roots" as const,
    probe: {
      workspaceWriteAllowed: true,
      controlWriteDenied: true,
      protectedReadDenied: true,
      networkDenied: true,
      unixSocketDenied: true,
    },
  };
}

function devkitError(code: string): (error: unknown) => boolean {
  return error => error instanceof DevkitError && error.code === code;
}

test("private Codex state is a 0700 canonical leaf outside forbidden roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-private-codex-state-"));
  try {
    const parent = path.join(root, "state-parent");
    const repository = path.join(root, "repository");
    const unsafeParent = path.join(root, "unsafe-parent");
    mkdirSync(parent, { mode: 0o755 });
    mkdirSync(repository, { mode: 0o700 });
    mkdirSync(unsafeParent, { mode: 0o700 });
    chmodSync(unsafeParent, 0o777);
    const state = new PrivateCodexStateRoot({ root: path.join(parent, "codex-home"), forbiddenRoots: [repository] });
    assert.equal(lstatSync(state.path).isSymbolicLink(), false);
    assert.equal(lstatSync(state.path).isDirectory(), true);
    assert.equal(lstatSync(state.path).mode & 0o077, 0);
    const forbiddenLeaf = path.join(repository, "codex-home");
    assert.throws(() => new PrivateCodexStateRoot({ root: forbiddenLeaf, forbiddenRoots: [repository] }), devkitError("PRIVATE_CODEX_STATE_OVERLAPS_FORBIDDEN_ROOT"));
    assert.equal(existsSync(forbiddenLeaf), false, "a rejected state root must not modify a forbidden tree");
    assert.throws(() => new PrivateCodexStateRoot({ root: path.join(unsafeParent, "codex-home"), forbiddenRoots: [repository] }), devkitError("PRIVATE_CODEX_STATE_PARENT_UNSAFE"));
    symlinkSync(state.path, path.join(parent, "linked-home"));
    assert.throws(() => new PrivateCodexStateRoot({ root: path.join(parent, "linked-home"), forbiddenRoots: [repository] }), devkitError("INVALID_PRIVATE_CODEX_STATE_ROOT"));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
  }
});

test("managed-auth Seatbelt launch owns persistent CODEX_HOME without a candidate workspace", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-managed-auth-launch-"));
  try {
    const stateParent = path.join(root, "state-parent");
    const control = path.join(root, "control");
    const candidate = path.join(root, "candidate");
    const packageBin = path.join(root, "node_modules", "@openai", "codex", "bin");
    mkdirSync(stateParent, { mode: 0o700 });
    mkdirSync(control, { mode: 0o700 });
    mkdirSync(candidate, { mode: 0o700 });
    mkdirSync(packageBin, { recursive: true, mode: 0o700 });
    const wrapper = path.join(packageBin, "codex.js");
    writeFileSync(wrapper, "// package-shaped test wrapper\n");
    const state = new PrivateCodexStateRoot({ root: path.join(stateParent, "auth"), forbiddenRoots: [control, candidate] });
    let captured: AppServerSubprocessSpec | undefined;
    let exited = false;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const launch = new MacosSeatbeltManagedAuthLaunch({
      subprocess: {
        spawn(spec) {
          captured = spec;
          return {
            stdin,
            stdout,
            stderr,
            control: undefined,
            collected: {},
            done: Promise.resolve({ exitCode: 0 }),
            terminate() {},
            waitForExit: async () => exited,
          };
        },
      },
      wrapper,
      state,
      deniedReadRoots: [control, candidate],
      sandboxExec: path.join(root, "sandbox-exec"),
      status: async () => supportedCapability(),
    });
    const prepared = await launch.prepare(new AbortController().signal);
    assert.equal(launch.purpose, "private-managed-chatgpt-oauth");
    assert.equal(captured?.cwd, state.path);
    assert.equal(captured?.env?.CODEX_HOME, state.path);
    assert.equal(typeof captured?.env?.HOME, "string");
    assert.notEqual(captured?.env?.HOME, state.path);
    assert.equal(captured?.argv[0], path.join(root, "sandbox-exec"));
    assert.match(String(captured?.argv[2]), /\(deny network\*\)/);
    assert.equal(captured?.argv.at(-1), "--stdio");
    const temporary = captured?.env?.TMPDIR;
    assert.equal(typeof temporary, "string");
    assert.equal(existsSync(temporary!), true);
    assert.equal(await prepared.release(true), false, "the caller must prove the managed child exited first");
    exited = true;
    assert.equal(await prepared.child.waitForExit(), true);
    assert.equal(await prepared.release(true), true);
    assert.equal(existsSync(temporary!), false);
    assert.equal(existsSync(state.path), true, "persistent managed-auth state is never removed with a session temp directory");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
  }
});

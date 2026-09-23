import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { byteHash, DevkitError, object } from "../contracts/task.js";
import { minimalEnvironment, redact, resolveRealWithin } from "../domain/security.js";
import { assertScope, frozenHash, snapshot, type Snapshot } from "./workspace.js";
import type { CodeExecutor, ExecutionRequest, ExecutionResult } from "../plugins/tasks.js";

const PROTOCOL = "sealed-patch-worker-v1" as const;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FEEDBACK_CHARS = 4 * 1024;
// `redact()` covers unquoted assignments. Source and patch data also commonly
// use JSON/JavaScript quoted values, so this protocol rejects those forms
// before any external worker can receive them.
const QUOTED_SECRET_ASSIGNMENT = /(\b(?:authorization|api[_-]?key|password|secret|token)\b["']?\s*[:=]\s*)["'][^"']*["']/gi;

export interface SealedPatchSourceFile {
  /** Portable candidate-relative path; never an absolute host path. */
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mode: number;
  /** UTF-8 source only; secret-looking content is rejected before dispatch. */
  readonly content: string;
}

/**
 * The only data plane a future independently isolated worker may receive.
 * It intentionally contains a by-value source snapshot rather than a
 * workspace path, host policy, credentials, environment, or frozen context.
 */
export interface SealedPatchWorkerRequest {
  readonly protocol: typeof PROTOCOL;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly description: string;
    readonly reproduction: { readonly steps: readonly string[]; readonly expected: string; readonly actual: string };
    readonly acceptanceCriteria: readonly { readonly id: string; readonly description: string }[];
  };
  readonly snapshot: {
    readonly id: string;
    readonly baseCommit: string;
    readonly files: readonly Omit<SealedPatchSourceFile, "content">[];
  };
  readonly source: readonly SealedPatchSourceFile[];
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  /** Bounded and redacted verifier feedback; it cannot carry host context. */
  readonly feedback: string;
}

/** A worker can return only a patch bound to the exact source snapshot. */
export interface SealedPatchProposal {
  readonly snapshotId: string;
  readonly patch: string;
}

export type SealedPatchWorkerResult =
  | { readonly state: "completed"; readonly proposal: SealedPatchProposal }
  | { readonly state: "failed" };

/**
 * `stop()` is an exit-proof contract: returning true means that this operation
 * can no longer read source or send a patch. It is called even after a result
 * settles so an adapter cannot mistake a partial transport response for a
 * quiescent worker.
 */
export interface SealedPatchWorkerOperation {
  readonly id: string;
  readonly result: Promise<unknown>;
  stop(): Promise<boolean> | boolean;
}

/**
 * This is a host integration seam, not an in-process isolation claim. A real
 * implementation must create a separately enforced workload and must return
 * no operation until it can later prove `stop()`.
 */
export interface SealedPatchWorker {
  readonly id: string;
  begin(request: SealedPatchWorkerRequest): SealedPatchWorkerOperation;
}

function bounded(value: string, limit: number): string {
  const safe = redacted(value);
  return safe.length <= limit ? safe : `${safe.slice(0, Math.max(0, limit - 1))}…`;
}

function redacted(value: string): string {
  return redact(value).replace(QUOTED_SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function containsSecretLike(value: string): boolean {
  return redacted(value) !== value;
}

function snapshotMatches(workspace: string, expected: Snapshot): boolean {
  return snapshot(workspace, expected.baseCommit, expected.policyHash, expected.planHash).id === expected.id;
}

function sourceSnapshot(request: ExecutionRequest): readonly SealedPatchSourceFile[] {
  if (!snapshotMatches(request.workspace, request.snapshot)) throw new DevkitError("SEALED_WORKER_SNAPSHOT_STALE");
  const files = request.snapshot.files.map(file => {
    const content = readFileSync(resolveRealWithin(request.workspace, file.path));
    if (content.byteLength !== file.size || byteHash(content) !== file.hash) throw new DevkitError("SEALED_WORKER_SNAPSHOT_STALE");
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content)) throw new DevkitError("SEALED_WORKER_NON_UTF8_SOURCE", file.path);
    if (containsSecretLike(text)) throw new DevkitError("POSSIBLE_SECRET_IN_SEALED_WORKER_SOURCE", file.path);
    return Object.freeze({ path: file.path, hash: file.hash, size: file.size, mode: file.mode, content: text });
  });
  // Recheck after every read so a concurrent mutation cannot be transferred as
  // a falsely named snapshot.
  if (!snapshotMatches(request.workspace, request.snapshot)) throw new DevkitError("SEALED_WORKER_SNAPSHOT_STALE");
  return Object.freeze(files);
}

/** Build the intentionally pathless, redacted by-value request for one worker operation. */
export function sealedPatchWorkerRequest(request: ExecutionRequest): SealedPatchWorkerRequest {
  const input = request.task.input;
  const source = sourceSnapshot(request);
  const files = Object.freeze(source.map(({ content: _content, ...file }) => Object.freeze(file)));
  return Object.freeze({
    protocol: PROTOCOL,
    task: Object.freeze({
      taskId: request.task.taskId,
      title: bounded(input.title, 512),
      description: bounded(input.description, 8_000),
      reproduction: Object.freeze({
        steps: Object.freeze(input.reproduction.steps.map(step => bounded(step, 1_024))),
        expected: bounded(input.reproduction.expected, 2_000),
        actual: bounded(input.reproduction.actual, 2_000),
      }),
      acceptanceCriteria: Object.freeze(input.acceptanceCriteria.map(criterion => Object.freeze({
        id: bounded(criterion.id, 100),
        description: bounded(criterion.description, 1_024),
      }))),
    }),
    snapshot: Object.freeze({ id: request.snapshot.id, baseCommit: request.snapshot.baseCommit, files }),
    source,
    allowedPaths: Object.freeze([...request.allowedPaths]),
    protectedPaths: Object.freeze([...request.protectedPaths]),
    feedback: bounded(request.feedback, MAX_FEEDBACK_CHARS),
  });
}

function safeOperation(value: unknown): value is SealedPatchWorkerOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<SealedPatchWorkerOperation>;
  return typeof operation.id === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(operation.id)
    && !!operation.result
    && typeof (operation.result as Promise<unknown>).then === "function"
    && typeof operation.stop === "function";
}

async function stop(operation: SealedPatchWorkerOperation): Promise<boolean> {
  try { return await operation.stop() === true; } catch { return false; }
}

async function awaitResult(operation: SealedPatchWorkerOperation, signal: AbortSignal): Promise<{ readonly state: "result"; readonly value: unknown } | { readonly state: "failed" } | { readonly state: "aborted" }> {
  if (signal.aborted) return { state: "aborted" };
  return await new Promise(resolve => {
    let settled = false;
    const finish = (value: { readonly state: "result"; readonly value: unknown } | { readonly state: "failed" } | { readonly state: "aborted" }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ state: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(operation.result).then(value => finish({ state: "result", value }), () => finish({ state: "failed" }));
  });
}

function proposal(value: unknown, snapshotId: string): string | undefined {
  const result = object(value, ["state", "proposal"]);
  if (result.state === "failed") {
    if (Object.hasOwn(result, "proposal")) throw new DevkitError("SEALED_PATCH_WORKER_RESULT_INVALID");
    return undefined;
  }
  if (result.state !== "completed" || !Object.hasOwn(result, "proposal")) throw new DevkitError("SEALED_PATCH_WORKER_RESULT_INVALID");
  const candidate = object(result.proposal, ["snapshotId", "patch"]);
  if (candidate.snapshotId !== snapshotId || typeof candidate.patch !== "string" || candidate.patch.includes("\0") || Buffer.byteLength(candidate.patch) > MAX_PATCH_BYTES) {
    throw new DevkitError(candidate.snapshotId !== snapshotId ? "SEALED_PATCH_PROPOSAL_STALE" : "SEALED_PATCH_WORKER_RESULT_INVALID");
  }
  if (containsSecretLike(candidate.patch)) throw new DevkitError("POSSIBLE_SECRET_IN_SEALED_PATCH");
  return candidate.patch;
}

function patchPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f\s]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new DevkitError("SEALED_PATCH_INVALID");
  }
  return value;
}

function permitted(file: string, paths: readonly string[]): boolean {
  return paths.some(entry => file === entry || (entry.endsWith("/") && file.startsWith(entry)));
}

/**
 * This first protocol accepts only ordinary text add/edit/delete diffs. It
 * intentionally rejects renames, copies, mode-only transitions, binary data,
 * quoted filenames and any path outside the host's write allowlist.
 */
export function assertSealedPatchPaths(patch: string, allowedPaths: readonly string[], protectedPaths: readonly string[]): void {
  if (!patch) return;
  let current: string | undefined;
  let oldName = false;
  let newName = false;
  let count = 0;
  const finishCurrent = (): void => {
    if (current !== undefined && (!oldName || !newName)) throw new DevkitError("SEALED_PATCH_INVALID");
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishCurrent();
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      const before = match?.[1];
      const after = match?.[2];
      if (before === undefined || after === undefined || before !== after) throw new DevkitError("SEALED_PATCH_INVALID");
      current = patchPath(before);
      if (!permitted(current, allowedPaths) || permitted(current, protectedPaths)) throw new DevkitError("SEALED_PATCH_PATH_REJECTED", current);
      oldName = false;
      newName = false;
      count += 1;
      continue;
    }
    if (line.startsWith("diff --git") || /^(similarity index|rename from|rename to|copy from|copy to|GIT binary patch|old mode|new mode)/.test(line)) {
      throw new DevkitError("SEALED_PATCH_INVALID");
    }
    if (line.startsWith("new file mode ") && line !== "new file mode 100644" && line !== "new file mode 100755") throw new DevkitError("SEALED_PATCH_INVALID");
    if (line.startsWith("deleted file mode ") && line !== "deleted file mode 100644" && line !== "deleted file mode 100755") throw new DevkitError("SEALED_PATCH_INVALID");
    if (line.startsWith("--- ")) {
      if (current === undefined || (line !== "--- /dev/null" && line !== `--- a/${current}`)) throw new DevkitError("SEALED_PATCH_INVALID");
      oldName = true;
    }
    if (line.startsWith("+++ ")) {
      if (current === undefined || (line !== "+++ /dev/null" && line !== `+++ b/${current}`)) throw new DevkitError("SEALED_PATCH_INVALID");
      newName = true;
    }
    if (line.startsWith("@@ ") && (current === undefined || !oldName || !newName)) throw new DevkitError("SEALED_PATCH_INVALID");
  }
  finishCurrent();
  if (!count) throw new DevkitError("SEALED_PATCH_INVALID");
}

function apply(workspace: string, patch: string): void {
  if (!patch) return;
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.safecrlf=true", "apply", "--index", "--whitespace=error", "--recount"], {
      cwd: workspace,
      env: minimalEnvironment(workspace),
      input: Buffer.from(patch, "utf8"),
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new DevkitError("SEALED_PATCH_APPLY_FAILED");
  }
}

/**
 * Applies a proposal only after a worker's exit proof. It does not give the
 * worker a candidate path; its source/input channel is by value and its only
 * accepted output is a bounded, path-validated Git patch.
 */
export class SealedPatchProposalExecutor implements CodeExecutor {
  readonly family = "sealed-patch-proposal-executor";
  readonly kind = "live" as const;

  constructor(private readonly worker: SealedPatchWorker) {
    if (!worker || typeof worker !== "object" || typeof worker.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(worker.id) || typeof worker.begin !== "function") {
      throw new DevkitError("INVALID_SEALED_PATCH_WORKER");
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.signal.aborted) return { stopped: true, failure: "CANCELLED" };
    let message: SealedPatchWorkerRequest;
    try {
      message = sealedPatchWorkerRequest(request);
    } catch (error) {
      // Building the request has not started a worker, so a local validation
      // failure can settle normally without claiming remote quiescence.
      return { stopped: true, failure: error instanceof DevkitError ? error.code : "SEALED_PATCH_WORKER_INPUT_INVALID" };
    }
    if (request.signal.aborted) return { stopped: true, failure: "CANCELLED" };
    let rawOperation: unknown;
    try {
      rawOperation = this.worker.begin(message);
    } catch {
      // A generic worker seam cannot prove whether a throwing launch already
      // started remote work. Retain the writer lease rather than claiming it
      // stopped; concrete workers must return an operation to make cleanup
      // observable.
      return { stopped: false };
    }
    if (!safeOperation(rawOperation)) return { stopped: false };
    const operation = rawOperation;
    const settled = await awaitResult(operation, request.signal);
    const stopped = await stop(operation);
    if (!stopped) return { stopped: false };
    if (settled.state === "aborted" || request.signal.aborted) return { stopped: true, failure: "CANCELLED" };
    if (settled.state === "failed") return { stopped: true, failure: "SEALED_PATCH_WORKER_FAILED" };
    try {
      const patch = proposal(settled.value, request.snapshot.id);
      if (patch === undefined) return { stopped: true, failure: "SEALED_PATCH_WORKER_FAILED" };
      assertSealedPatchPaths(patch, request.allowedPaths, request.protectedPaths);
      if (!snapshotMatches(request.workspace, request.snapshot)) throw new DevkitError("SEALED_WORKER_MUTATED_WORKSPACE");
      apply(request.workspace, patch);
      const after = snapshot(request.workspace, request.snapshot.baseCommit, request.snapshot.policyHash, request.snapshot.planHash);
      assertScope(request.snapshot, after, request.allowedPaths);
      if (frozenHash(request.snapshot, request.protectedPaths) !== frozenHash(after, request.protectedPaths)) throw new DevkitError("FROZEN_TESTS_CHANGED");
      return { stopped: true, runId: this.worker.id };
    } catch (error) {
      return { stopped: true, failure: error instanceof DevkitError ? error.code : "SEALED_PATCH_WORKER_RESULT_INVALID" };
    }
  }
}

export function createSealedPatchProposalExecutor(worker: SealedPatchWorker): SealedPatchProposalExecutor {
  return new SealedPatchProposalExecutor(worker);
}

import path from "node:path";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DevkitError, hash, object, text, validateTaskInput, type TaskRecord } from "../contracts/task.js";
import { validateHostPolicy } from "../contracts/policy.js";
import { evidenceGate, type CheckEvidence } from "../domain/state-machine.js";
import { resolveRealWithin, redact } from "../domain/security.js";
import { TaskStore, type TaskLease } from "../adapters/store.js";
import { ContextStore, type LoadedContext } from "../adapters/context.js";
import { runCommand, type CommandConfinement, type CommandSpec } from "../adapters/process.js";
import { resolveBase, prepareWorkspace, snapshot, assertScope, frozenHash, exportPatch, writeArtifact, type Snapshot } from "../adapters/workspace.js";
import { validateReview, type Reviewer, type Finding } from "../adapters/review.js";
export interface RepositoryPolicy {
  path: string;
  allowedPaths: string[];
  protectedPaths: string[];
  /** Optional host-owned read allowlist for immutable task context files. */
  contextPaths?: string[];
}
/** Trusted host metadata only; the credential value remains outside JSON policy. */
export interface ReviewerPolicy { endpoint: string; model: string; credentialEnv: string; timeoutMs?: number }
/**
 * Opt-in registration shape for the provider mounted through DevKit's own
 * scoped subprocess boundary. It remains unable to reach a model until a
 * separately implemented credential broker is available.
 */
export interface CodexAppServerPolicy { mode: "macos-seatbelt-v1"; deniedReadRoots: string[] }
/**
 * Host-only metadata for the local, human approval presentation. The secret
 * value itself is deliberately outside JSON policy and is read only when the
 * native host explicitly starts this listener.
 */
export interface CodexApprovalControlPlanePolicy {
  mode: "loopback-v1";
  credentialEnv: string;
  operatorId: string;
  port?: number;
}
export interface HostPolicy {
  dataRoot: string; executionMode: "disabled" | "fixture"; fixtureDriver?: "pagination-v1";
  reviewer?: ReviewerPolicy;
  codexAppServer?: CodexAppServerPolicy;
  codexApprovalControlPlane?: CodexApprovalControlPlanePolicy;
  repositories: Record<string, RepositoryPolicy>; verificationProfiles: Record<string, CommandSpec[]>;
  maxRetries: number; maxDurationMs: number;
}
export interface ExecutionRequest {
  task: TaskRecord; workspace: string; snapshot: Snapshot; feedback: string; signal: AbortSignal;
  allowedPaths: readonly string[]; protectedPaths: readonly string[];
  /** Private, base-pinned text selected from host-authorized context paths. */
  context?: import("../adapters/context.js").LoadedContext;
}
/** An executor always reports whether its owned writer has reached quiescence. */
export interface ExecutionResult { readonly stopped: boolean; readonly runId?: string; readonly failure?: string }
export interface CodeExecutor { readonly family: string; readonly kind: "fixture" | "live"; execute(request: ExecutionRequest): Promise<ExecutionResult> }
export type RecoveryWorkspaceState = "not-created" | "unchanged" | "changed" | "untracked" | "unreadable";
/**
 * Read-only facts assembled by DevKit before a trusted host decides whether an
 * interrupted task may receive a new candidate clone. `changed` and
 * `untracked` are intentionally not treated as a safe in-place resume.
 */
export interface RecoveryInspection {
  readonly task: TaskRecord;
  readonly lease: TaskLease;
  readonly policyCurrent: boolean;
  readonly baseAvailable: boolean;
  readonly expectedSnapshotId?: string;
  readonly observedSnapshotId?: string;
  readonly workspaceState: RecoveryWorkspaceState;
  /** Binds an authorization to exact durable facts and prevents TOCTOU reuse. */
  readonly fingerprint: string;
}
/** Host-only approval result; this shape is never exposed as a DSH tool input. */
export interface RecoveryAuthorization {
  readonly action: "retry-from-base";
  readonly taskId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly approvalId: string;
  readonly oldWriterStopped: true;
}
/**
 * Integrate an authenticated operator control plane here. A plain callback is
 * a test seam, not an identity system; native DSH wiring deliberately leaves
 * it unconfigured until such a control plane exists.
 */
export interface RecoveryAuthority {
  authorizeRecovery(inspection: RecoveryInspection): Promise<unknown>;
}
export interface RuntimeAdapters {
  executor?: CodeExecutor; reviewer?: Reviewer; confirmFinding?: (finding: Finding, request: ExecutionRequest) => Promise<boolean>;
  /** Host-owned command boundary; a missing confinement must not be treated as a live sandbox. */
  commandConfinement?: CommandConfinement;
  /** Trusted host-only guard run before any fixture verification command. */
  workspaceGuard?: { readonly id: string; assertWorkspace(workspace: string): void };
  /** Host-only recovery authorization; not available to normal DSH tool calls. */
  recoveryAuthority?: RecoveryAuthority;
}
interface ActiveRun { controller: AbortController; done: Promise<TaskRecord> }

/** Host-owned application service. The model-facing tool surface deliberately excludes accept and policy mutation. */
export class Devkit {
  readonly store: TaskStore;
  private readonly policy: HostPolicy;
  private readonly policyHash: string;
  private readonly contexts: ContextStore;
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;
  constructor(policy: HostPolicy, private readonly adapters: RuntimeAdapters = {}) {
    policy = validateHostPolicy(policy);
    if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 2 || !Number.isFinite(policy.maxDurationMs) || policy.maxDurationMs <= 0) throw new DevkitError("INVALID_BUDGET");
    this.policy = structuredClone(policy); this.policyHash = hash(this.policy);
    mkdirSync(policy.dataRoot, { recursive: true, mode: 0o700 });
    for (const repo of Object.values(policy.repositories)) {
      const base = realpathSync(repo.path), data = realpathSync(policy.dataRoot);
      if (data === base || data.startsWith(`${base}${path.sep}`) || base.startsWith(`${data}${path.sep}`)) throw new DevkitError("CONTROL_PLANE_OVERLAPS_REPOSITORY");
      for (const candidate of [...repo.allowedPaths, ...repo.protectedPaths]) resolveRealWithin(base, candidate);
      for (const reference of repo.contextPaths ?? []) {
        try {
          const candidate = resolveRealWithin(base, reference);
          const stat = lstatSync(candidate);
          if (reference.endsWith("/") ? !stat.isDirectory() : !stat.isFile()) throw new DevkitError("INVALID_CONTEXT_POLICY", reference);
        } catch (error) {
          if (error instanceof DevkitError) throw error;
          throw new DevkitError("INVALID_CONTEXT_POLICY", reference);
        }
      }
    }
    this.contexts = new ContextStore(resolveRealWithin(realpathSync(policy.dataRoot), "contexts"));
    this.store = new TaskStore(path.join(policy.dataRoot, "tasks.sqlite"));
  }
  create(raw: unknown): TaskRecord {
    if (this.closing) throw new DevkitError("PLUGIN_STOPPING");
    const input = validateTaskInput(raw);
    if (!Object.hasOwn(this.policy.repositories, input.repositoryRef)) throw new DevkitError("REPOSITORY_NOT_AUTHORIZED");
    if (!Object.hasOwn(this.policy.verificationProfiles, input.verificationProfile)) throw new DevkitError("UNKNOWN_VERIFICATION_PROFILE");
    const repository = this.policy.repositories[input.repositoryRef]!;
    const baseCommit = resolveBase(repository.path, input.baseRef);
    const frozenContext = input.contextRefs?.length
      ? this.contexts.freeze(repository.path, baseCommit, input.contextRefs, repository.contextPaths ?? [])
      : undefined;
    return this.store.create(input, this.policyHash, baseCommit, frozenContext);
  }
  status(id: string): TaskRecord { return this.store.get(id); }
  doctor(): object {
    return { schemaVersion: 1, node: process.version, platform: process.platform, executionMode: this.policy.executionMode,
      persistence: { state: "supported", implementation: "node:sqlite", atomicEvents: true },
      isolation: { filesystem: "unsupported", network: "unsupported", enforcement: "none" },
      cancellation: { state: process.platform === "linux" ? "supported" : "unverified", enforcement: "partial", note: "Process groups only; escaped descendants require an OS sandbox." },
      nativeRuntime: { state: "unverified" }, live: { state: "unsupported", reason: "LIVE_SANDBOX_NOT_IMPLEMENTED" },
      fixture: this.policy.executionMode === "fixture"
        ? { state: "enabled", driver: this.policy.fixtureDriver, deterministic: true, nonProduction: true }
        : { state: "disabled" },
      executor: this.adapters.executor ? { family: this.adapters.executor.family, kind: this.adapters.executor.kind } : { state: "unconfigured" },
      reviewer: this.adapters.reviewer ? { family: this.adapters.reviewer.family, kind: this.adapters.reviewer.kind } : { state: "unconfigured" } };
  }
  async run(id: string, signal: AbortSignal = new AbortController().signal, executorOverride?: CodeExecutor): Promise<TaskRecord> {
    if (this.closing) throw new DevkitError("PLUGIN_STOPPING");
    if (signal.aborted) throw new DevkitError("CANCELLED");
    if (this.active.has(id)) throw new DevkitError("TASK_ALREADY_RUNNING");
    const task = this.store.get(id), repo = this.policy.repositories[task.input.repositoryRef];
    if (!repo || task.policyHash !== this.policyHash) throw new DevkitError("POLICY_CHANGED");
    const runId = randomUUID();
    this.store.acquire(id, realpathSync(repo.path), runId);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(this.policy.maxDurationMs)]);
    const done = Promise.resolve().then(() => this.execute(id, repo, combined, executorOverride));
    this.active.set(id, { controller, done });
    try { return await done; } finally { this.active.delete(id); }
  }
  private async execute(id: string, repo: RepositoryPolicy, signal: AbortSignal, executorOverride?: CodeExecutor): Promise<TaskRecord> {
    let stopped = true;
    const set = (patch: Parameters<TaskStore["update"]>[2], event: string, payload: unknown = {}) => this.store.update(id, this.store.get(id).version, patch, event, payload);
    const stage = (value: TaskRecord["stage"]) => { signal.throwIfAborted(); set({ stage: value }, "stage", { stage: value }); };
    try {
      // There is intentionally no unsafe live fallback or model-selectable executionMode.
      if (this.policy.executionMode !== "fixture") throw new DevkitError("LIVE_SANDBOX_NOT_IMPLEMENTED");
      // Fixture mode is an explicitly configured test harness, not a sandbox or a live
      // execution path. Keep its platform result visible in doctor/report instead of
      // making portable deterministic tests hang before their fixture can settle.
      const executor = executorOverride ?? this.adapters.executor, reviewer = this.adapters.reviewer;
      if (!executor || !reviewer) throw new DevkitError("EXECUTOR_OR_REVIEWER_MISSING");
      if (executor.kind !== "fixture" || reviewer.kind !== "fixture") throw new DevkitError("LIVE_ADAPTER_REQUIRES_SANDBOX");
      if (executor.family === reviewer.family) throw new DevkitError("INDEPENDENT_REVIEW_REQUIRED");
      const task = this.store.get(id), checks = this.policy.verificationProfiles[task.input.verificationProfile]!;
      if (!checks.length || new Set(checks.map((c) => c.id)).size !== checks.length || task.input.acceptanceCriteria.some((c) => !checks.some((v) => v.criteria.includes(c.id)))) throw new DevkitError("ACCEPTANCE_MAPPING_MISSING");
      const base = task.baseCommit ?? resolveBase(repo.path, task.input.baseRef), planHash = hash(checks);
      const activeRunId = this.store.get(id).runId;
      if (activeRunId === undefined) throw new DevkitError("RUN_ID_MISSING");
      const work = prepareWorkspace(repo.path, path.join(this.policy.dataRoot, "workspaces"), id, base, activeRunId);
      set({ workspace: work, baseCommit: base }, "workspace_created", { base });
      if (this.adapters.workspaceGuard) {
        this.adapters.workspaceGuard.assertWorkspace(work);
        set({}, "workspace_guarded", { guard: this.adapters.workspaceGuard.id });
      }
      const capture = () => snapshot(work, base, this.policyHash, planHash);
      stage("context");
      let context: LoadedContext | undefined;
      const requestedContext = task.input.contextRefs ?? [];
      if (requestedContext.length) {
        if (!task.frozenContext || task.frozenContext.baseCommit !== base || requestedContext.length !== task.frozenContext.files.length || requestedContext.some((reference, index) => reference !== task.frozenContext?.files[index]?.path)) {
          throw new DevkitError("CONTEXT_MANIFEST_MISMATCH");
        }
        context = this.contexts.load(task.frozenContext);
        this.contexts.assertWorkspace(context, work);
        set({}, "context_loaded", {
          manifestHash: context.manifest.manifestHash,
          baseCommit: context.manifest.baseCommit,
          files: context.manifest.files,
        });
      } else if (task.frozenContext !== undefined) {
        throw new DevkitError("CONTEXT_MANIFEST_UNEXPECTED");
      }
      const baseline = capture(), protectedHash = frozenHash(baseline, repo.protectedPaths);
      set({}, "baseline_snapshot", baseline);
      if (!repo.protectedPaths.length || !baseline.files.some((f) => repo.protectedPaths.some((p) => f.path === p || (p.endsWith("/") && f.path.startsWith(p))))) throw new DevkitError("FROZEN_TESTS_MISSING");
      const ensureFrozen = (candidate: Snapshot) => {
        if (frozenHash(candidate, repo.protectedPaths) !== protectedHash) throw new DevkitError("FROZEN_TESTS_CHANGED");
        assertScope(baseline, candidate, repo.allowedPaths);
      };
      stage("reproduce");
      let reproduced = false;
      for (const check of checks) {
        const result = await runCommand(check, work, signal, this.adapters.commandConfinement); stopped = result.stopped;
        set({}, "reproduction", { ...result, snapshotId: baseline.id });
        if (capture().id !== baseline.id) throw new DevkitError("REPRODUCTION_MUTATED_SOURCE");
        if (!stopped) throw new DevkitError("STOP_UNCONFIRMED");
        if (result.classification === "cancelled") throw new DevkitError("CANCELLED");
        if (result.classification === "failed_infrastructure") throw new DevkitError("REPRODUCTION_INFRASTRUCTURE_ERROR");
        if (result.classification === "failed_assertion") reproduced = true;
      }
      if (!reproduced) throw new DevkitError("NOT_REPRODUCED");
      let feedback = "";
      for (;;) {
        stage("implement");
        const request: ExecutionRequest = {
          task: this.store.get(id), workspace: work, snapshot: capture(), feedback, signal,
          allowedPaths: repo.allowedPaths, protectedPaths: repo.protectedPaths,
          ...(context === undefined ? {} : { context }),
        };
        set({}, "executor_dispatch", { operationId: randomUUID(), attempt: this.store.get(id).retryCount + 1, snapshotId: request.snapshot.id });
        stopped = false;
        const executed = await executor.execute(request); stopped = executed.stopped;
        set({}, "executor_settled", {
          stopped,
          ...(executed.runId === undefined ? {} : { runId: executed.runId }),
          ...(executed.failure === undefined ? {} : { failure: executed.failure }),
        });
        if (!stopped) throw new DevkitError("STOP_UNCONFIRMED");
        if (executed.failure !== undefined) throw new DevkitError(executed.failure);
        stage("snapshot");
        const candidate = capture(); ensureFrozen(candidate);
        set({ snapshotId: candidate.id }, "snapshot", candidate);
        stage("verify");
        const evidence: CheckEvidence[] = []; let failed = false;
        for (const check of checks) {
          if (capture().id !== candidate.id) throw new DevkitError("STALE_SNAPSHOT");
          const result = await runCommand(check, work, signal, this.adapters.commandConfinement); stopped = result.stopped;
          set({}, "verification", { ...result, snapshotId: candidate.id, criteria: check.criteria });
          if (capture().id !== candidate.id) throw new DevkitError("VERIFICATION_MUTATED_SOURCE");
          if (!stopped) throw new DevkitError("STOP_UNCONFIRMED");
          if (result.classification === "cancelled") throw new DevkitError("CANCELLED");
          evidence.push({ checkId: check.id, snapshotId: candidate.id, criteria: check.criteria, passed: result.classification === "passed" });
          failed ||= result.classification !== "passed";
        }
        if (failed) { feedback = "Required verification failed; preserve the frozen tests."; }
        else {
          stage("review");
          const patch = exportPatch(work, base);
          const reviewed = validateReview(await reviewer.review({ snapshotId: candidate.id, task: task.input, patch, evidence, signal }), candidate.id);
          if (capture().id !== candidate.id) throw new DevkitError("REVIEW_MUTATED_SOURCE");
          set({}, "review", reviewed);
          stage("triage");
          const high = reviewed.findings.filter((f) => f.severity === "P0" || f.severity === "P1");
          const backlog = [...new Map(reviewed.findings.filter((f) => !high.includes(f)).map((f) => [f.fingerprint, f])).values()];
          set({}, "backlog", { snapshotId: candidate.id, findings: backlog });
          let confirmed = high.length > 0;
          for (const finding of high) {
            const proof = this.adapters.confirmFinding ? await this.adapters.confirmFinding(finding, { ...request, snapshot: candidate }) : false;
            set({}, "triage", { snapshotId: candidate.id, fingerprint: finding.fingerprint, disposition: proof ? "confirmed" : "unconfirmed" });
            if (!proof) confirmed = false;
          }
          if (capture().id !== candidate.id) throw new DevkitError("TRIAGE_MUTATED_SOURCE");
          if (high.length && !confirmed) return set({ status: "awaiting_human", readyForAcceptance: false, reason: "unconfirmed_high_risk" }, "human_required");
          if (!high.length && evidenceGate(candidate.id, task.input.acceptanceCriteria.map((c) => c.id), checks.map((c) => c.id), evidence, { snapshotId: reviewed.snapshotId, passed: true, blockingFindings: 0 })) {
            stage("package");
            if (capture().id !== candidate.id) throw new DevkitError("STALE_SNAPSHOT");
            const artifact = writeArtifact(path.join(this.policy.dataRoot, "artifacts"), id, "changes.patch", patch);
            set({}, "artifact", { ...artifact, snapshotId: candidate.id });
            return set({ status: "awaiting_human", reason: "final_acceptance", readyForAcceptance: true }, "ready_for_acceptance", { snapshotId: candidate.id, mode: "fixture" });
          }
          feedback = JSON.stringify(high);
        }
        const current = this.store.get(id);
        if (current.retryCount >= this.policy.maxRetries) return set({ status: "awaiting_human", reason: "retry_limit", readyForAcceptance: false }, "retry_limit");
        set({ retryCount: current.retryCount + 1 }, "retry_scheduled", { feedback });
      }
    } catch (error) {
      const code = error instanceof DevkitError ? error.code : signal.aborted ? "CANCELLED" : "RUNTIME_ERROR";
      if (!stopped) return set({ status: "interrupted", readyForAcceptance: false, reason: "stop_unconfirmed" }, "interrupted", { code });
      if (signal.aborted || code === "CANCELLED") {
        if (this.store.get(id).status !== "cancelling") set({ status: "cancelling", readyForAcceptance: false }, "cancelling");
        return set({ status: "cancelled", readyForAcceptance: false, reason: "cancelled" }, "cancelled");
      }
      return set({ status: "blocked", readyForAcceptance: false, reason: code }, "blocked", { code });
    } finally {
      const current = this.store.get(id);
      if (stopped && current.runId) this.store.release(id, current.runId);
    }
  }
  async cancel(id: string): Promise<TaskRecord> {
    const active = this.active.get(id);
    if (active) {
      const current = this.store.get(id);
      if (current.status === "running") this.store.update(id, current.version, { status: "cancelling", readyForAcceptance: false }, "cancel_requested");
      active.controller.abort(); await active.done; return this.store.get(id);
    }
    const current = this.store.get(id);
    if (this.store.hasLease(id)) throw new DevkitError("STOP_UNCONFIRMED");
    if (current.status === "cancelled" || current.status === "completed") return current;
    return this.store.update(id, current.version, { status: "cancelled", readyForAcceptance: false, reason: "cancelled" }, "cancelled");
  }
  private expectedRecoverySnapshot(id: string): string | undefined {
    for (const event of [...this.store.history(id)].reverse()) {
      if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
      const payload = event.payload as Record<string, unknown>;
      const fromSnapshotId = payload.snapshotId;
      const fromSnapshot = (event.type === "baseline_snapshot" || event.type === "snapshot") ? payload.id : undefined;
      const value = typeof fromSnapshotId === "string" ? fromSnapshotId : fromSnapshot;
      if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
    }
    return undefined;
  }
  private inspectRecovery(id: string): RecoveryInspection {
    if (this.active.has(id)) throw new DevkitError("TASK_ALREADY_RUNNING");
    const task = this.store.get(id);
    if (task.status !== "interrupted") throw new DevkitError("RECOVERY_TASK_NOT_INTERRUPTED");
    const lease = this.store.lease(id);
    if (!lease || !task.runId || lease.runId !== task.runId) throw new DevkitError("RECOVERY_LEASE_CHANGED");
    const repository = this.policy.repositories[task.input.repositoryRef];
    const checks = repository === undefined ? undefined : this.policy.verificationProfiles[task.input.verificationProfile];
    let repositoryCurrent = false;
    try { repositoryCurrent = repository !== undefined && realpathSync(repository.path) === lease.resource; } catch { /* inspected below as unavailable */ }
    const policyCurrent = task.policyHash === this.policyHash && repositoryCurrent && checks !== undefined;
    let baseAvailable = false;
    let planHash: string | undefined;
    if (policyCurrent && task.baseCommit !== undefined && checks !== undefined && checks.length > 0) {
      try {
        baseAvailable = resolveBase(repository!.path, task.baseCommit) === task.baseCommit;
        planHash = hash(checks);
      } catch { /* a lost base commit is a hard recovery preflight failure */ }
    }
    const expectedSnapshotId = this.expectedRecoverySnapshot(id);
    let observedSnapshotId: string | undefined;
    let workspaceState: RecoveryWorkspaceState;
    if (task.workspace === undefined) {
      workspaceState = "not-created";
    } else if (!baseAvailable || planHash === undefined || !existsSync(task.workspace)) {
      workspaceState = "unreadable";
    } else {
      try {
        const workspacesRoot = realpathSync(path.join(this.policy.dataRoot, "workspaces"));
        const workspace = realpathSync(task.workspace);
        const relative = path.relative(workspacesRoot, workspace);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new DevkitError("RECOVERY_WORKSPACE_NOT_OWNED");
        observedSnapshotId = snapshot(workspace, task.baseCommit!, this.policyHash, planHash).id;
        workspaceState = expectedSnapshotId === undefined
          ? "untracked"
          : observedSnapshotId === expectedSnapshotId ? "unchanged" : "changed";
      } catch {
        workspaceState = "unreadable";
      }
    }
    const fingerprint = hash({
      taskId: task.taskId,
      taskVersion: task.version,
      runId: lease.runId,
      leaseResource: lease.resource,
      leaseAcquiredAt: lease.acquiredAt,
      policyCurrent,
      baseAvailable,
      ...(expectedSnapshotId === undefined ? {} : { expectedSnapshotId }),
      ...(observedSnapshotId === undefined ? {} : { observedSnapshotId }),
      workspaceState,
    });
    return {
      task: structuredClone(task), lease, policyCurrent, baseAvailable,
      ...(expectedSnapshotId === undefined ? {} : { expectedSnapshotId }),
      ...(observedSnapshotId === undefined ? {} : { observedSnapshotId }),
      workspaceState, fingerprint,
    };
  }
  private validateRecoveryAuthorization(value: unknown, inspection: RecoveryInspection): RecoveryAuthorization {
    const authorization = object(value, ["action", "taskId", "runId", "fingerprint", "approvalId", "oldWriterStopped"]);
    if (authorization.action !== "retry-from-base" || authorization.oldWriterStopped !== true) throw new DevkitError("RECOVERY_AUTHORIZATION_REJECTED");
    const taskId = text(authorization.taskId, "recovery.taskId", 100);
    const runId = text(authorization.runId, "recovery.runId", 100);
    const fingerprint = text(authorization.fingerprint, "recovery.fingerprint", 100);
    const approvalId = text(authorization.approvalId, "recovery.approvalId", 200);
    if (taskId !== inspection.task.taskId || runId !== inspection.lease.runId || fingerprint !== inspection.fingerprint) throw new DevkitError("RECOVERY_AUTHORIZATION_STALE");
    return { action: "retry-from-base", taskId, runId, fingerprint, approvalId, oldWriterStopped: true };
  }
  /** Read only. Normal tool callers cannot release a retained writer lease. */
  resume(id: string): RecoveryInspection {
    if (this.adapters.recoveryAuthority === undefined) {
      this.store.get(id);
      throw new DevkitError("RECOVERY_REQUIRES_OPERATOR", "An authenticated host recovery authority must prove the old writer stopped before a fresh candidate can be queued.");
    }
    return this.inspectRecovery(id);
  }
  /**
   * Trusted host-only recovery action. It preserves the interrupted clone,
   * invalidates its current snapshot reference, and queues a new clone from
   * the frozen base only after a bound authorization and a second inspection.
   */
  async recover(id: string): Promise<TaskRecord> {
    if (this.closing) throw new DevkitError("PLUGIN_STOPPING");
    const authority = this.adapters.recoveryAuthority;
    if (authority === undefined) throw new DevkitError("RECOVERY_REQUIRES_OPERATOR");
    const before = this.inspectRecovery(id);
    if (!before.policyCurrent) throw new DevkitError("POLICY_CHANGED");
    if (!before.baseAvailable) throw new DevkitError("RECOVERY_PREFLIGHT_FAILED");
    const authorization = this.validateRecoveryAuthorization(await authority.authorizeRecovery(structuredClone(before)), before);
    const after = this.inspectRecovery(id);
    if (after.fingerprint !== before.fingerprint) throw new DevkitError("RECOVERY_STATE_CHANGED");
    return this.store.requeueRecovered(id, after.task.version, authorization.runId, {
      // An authority may internally use a signed or otherwise sensitive
      // approval artifact. Persist only its stable audit hash, never the raw
      // artifact, in task history/report output.
      approvalHash: hash(authorization.approvalId),
      authorizationFingerprint: authorization.fingerprint,
      workspaceState: after.workspaceState,
      ...(after.expectedSnapshotId === undefined ? {} : { expectedSnapshotId: after.expectedSnapshotId }),
      ...(after.observedSnapshotId === undefined ? {} : { observedSnapshotId: after.observedSnapshotId }),
    });
  }
  report(id: string): object {
    return JSON.parse(redact(JSON.stringify({ schemaVersion: 1, task: this.store.get(id), events: this.store.history(id), evidenceMode: this.policy.executionMode, liveValidated: false }))) as object;
  }
  /** Host-only acceptance; deliberately NOT registered as a DSH tool. */
  accept(id: string, snapshotId: string, actor: string): TaskRecord {
    const task = this.store.get(id);
    if (!actor.trim() || this.store.hasLease(id) || task.policyHash !== this.policyHash || !task.readyForAcceptance || task.reason !== "final_acceptance" || task.snapshotId !== snapshotId || !task.workspace || !task.baseCommit) throw new DevkitError("ACCEPTANCE_NOT_READY");
    const checks = this.policy.verificationProfiles[task.input.verificationProfile]!;
    if (snapshot(task.workspace, task.baseCommit, this.policyHash, hash(checks)).id !== snapshotId) throw new DevkitError("STALE_SNAPSHOT");
    return this.store.update(id, task.version, { status: "completed", readyForAcceptance: false, reason: "human_accepted" }, "human_accepted", { actor, snapshotId });
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((r) => r.done));
    this.store.close();
  }
}

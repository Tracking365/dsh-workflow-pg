import path from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DevkitError, hash, validateTaskInput, type TaskRecord } from "../contracts/task.js";
import { validateHostPolicy } from "../contracts/policy.js";
import { evidenceGate, type CheckEvidence } from "../domain/state-machine.js";
import { resolveRealWithin, redact } from "../domain/security.js";
import { TaskStore } from "../adapters/store.js";
import { runCommand, type CommandSpec } from "../adapters/process.js";
import { resolveBase, prepareWorkspace, snapshot, assertScope, frozenHash, exportPatch, writeArtifact, type Snapshot } from "../adapters/workspace.js";
import { validateReview, type Reviewer, type Finding } from "../adapters/review.js";
export interface RepositoryPolicy { path: string; allowedPaths: string[]; protectedPaths: string[] }
export interface HostPolicy {
  dataRoot: string; executionMode: "disabled" | "fixture";
  repositories: Record<string, RepositoryPolicy>; verificationProfiles: Record<string, CommandSpec[]>;
  maxRetries: number; maxDurationMs: number;
}
export interface ExecutionRequest { task: TaskRecord; workspace: string; snapshot: Snapshot; feedback: string; signal: AbortSignal }
export interface CodeExecutor { readonly family: string; readonly kind: "fixture" | "live"; execute(request: ExecutionRequest): Promise<{ stopped: boolean; runId: string }> }
export interface RuntimeAdapters { executor?: CodeExecutor; reviewer?: Reviewer; confirmFinding?: (finding: Finding, request: ExecutionRequest) => Promise<boolean> }
interface ActiveRun { controller: AbortController; done: Promise<TaskRecord> }

/** Host-owned application service. The model-facing tool surface deliberately excludes accept and policy mutation. */
export class Devkit {
  readonly store: TaskStore;
  private readonly policy: HostPolicy;
  private readonly policyHash: string;
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
    }
    this.store = new TaskStore(path.join(policy.dataRoot, "tasks.sqlite"));
  }
  create(raw: unknown): TaskRecord {
    if (this.closing) throw new DevkitError("PLUGIN_STOPPING");
    const input = validateTaskInput(raw);
    if (!Object.hasOwn(this.policy.repositories, input.repositoryRef)) throw new DevkitError("REPOSITORY_NOT_AUTHORIZED");
    if (!Object.hasOwn(this.policy.verificationProfiles, input.verificationProfile)) throw new DevkitError("UNKNOWN_VERIFICATION_PROFILE");
    if (input.contextRefs?.length) throw new DevkitError("CONTEXT_REFERENCES_NOT_YET_SUPPORTED");
    return this.store.create(input, this.policyHash, resolveBase(this.policy.repositories[input.repositoryRef]!.path, input.baseRef));
  }
  status(id: string): TaskRecord { return this.store.get(id); }
  doctor(): object {
    return { schemaVersion: 1, node: process.version, platform: process.platform, executionMode: this.policy.executionMode,
      persistence: { state: "supported", implementation: "node:sqlite", atomicEvents: true },
      isolation: { filesystem: "unsupported", network: "unsupported", enforcement: "none" },
      cancellation: { state: process.platform === "linux" ? "supported" : "unverified", enforcement: "partial", note: "Process groups only; escaped descendants require an OS sandbox." },
      nativeRuntime: { state: "unverified" }, live: { state: "unsupported", reason: "LIVE_SANDBOX_NOT_IMPLEMENTED" },
      executor: this.adapters.executor ? { family: this.adapters.executor.family, kind: this.adapters.executor.kind } : { state: "unconfigured" },
      reviewer: this.adapters.reviewer ? { family: this.adapters.reviewer.family, kind: this.adapters.reviewer.kind } : { state: "unconfigured" } };
  }
  async run(id: string, signal: AbortSignal = new AbortController().signal): Promise<TaskRecord> {
    if (this.closing) throw new DevkitError("PLUGIN_STOPPING");
    if (signal.aborted) throw new DevkitError("CANCELLED");
    if (this.active.has(id)) throw new DevkitError("TASK_ALREADY_RUNNING");
    const task = this.store.get(id), repo = this.policy.repositories[task.input.repositoryRef];
    if (!repo || task.policyHash !== this.policyHash) throw new DevkitError("POLICY_CHANGED");
    const runId = randomUUID();
    this.store.acquire(id, realpathSync(repo.path), runId);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(this.policy.maxDurationMs)]);
    const done = Promise.resolve().then(() => this.execute(id, repo, combined));
    this.active.set(id, { controller, done });
    try { return await done; } finally { this.active.delete(id); }
  }
  private async execute(id: string, repo: RepositoryPolicy, signal: AbortSignal): Promise<TaskRecord> {
    let stopped = true;
    const set = (patch: Parameters<TaskStore["update"]>[2], event: string, payload: unknown = {}) => this.store.update(id, this.store.get(id).version, patch, event, payload);
    const stage = (value: TaskRecord["stage"]) => { signal.throwIfAborted(); set({ stage: value }, "stage", { stage: value }); };
    try {
      // There is intentionally no unsafe live fallback or model-selectable executionMode.
      if (this.policy.executionMode !== "fixture") throw new DevkitError("LIVE_SANDBOX_NOT_IMPLEMENTED");
      // Fixture mode is an explicitly configured test harness, not a sandbox or a live
      // execution path. Keep its platform result visible in doctor/report instead of
      // making portable deterministic tests hang before their fixture can settle.
      const executor = this.adapters.executor, reviewer = this.adapters.reviewer;
      if (!executor || !reviewer) throw new DevkitError("EXECUTOR_OR_REVIEWER_MISSING");
      if (executor.kind !== "fixture" || reviewer.kind !== "fixture") throw new DevkitError("LIVE_ADAPTER_REQUIRES_SANDBOX");
      if (executor.family === reviewer.family) throw new DevkitError("INDEPENDENT_REVIEW_REQUIRED");
      const task = this.store.get(id), checks = this.policy.verificationProfiles[task.input.verificationProfile]!;
      if (!checks.length || new Set(checks.map((c) => c.id)).size !== checks.length || task.input.acceptanceCriteria.some((c) => !checks.some((v) => v.criteria.includes(c.id)))) throw new DevkitError("ACCEPTANCE_MAPPING_MISSING");
      const base = task.baseCommit ?? resolveBase(repo.path, task.input.baseRef), planHash = hash(checks);
      const work = prepareWorkspace(repo.path, path.join(this.policy.dataRoot, "workspaces"), id, base);
      set({ workspace: work, baseCommit: base }, "workspace_created", { base });
      const capture = () => snapshot(work, base, this.policyHash, planHash);
      stage("context");
      const baseline = capture(), protectedHash = frozenHash(baseline, repo.protectedPaths);
      if (!repo.protectedPaths.length || !baseline.files.some((f) => repo.protectedPaths.some((p) => f.path === p || (p.endsWith("/") && f.path.startsWith(p))))) throw new DevkitError("FROZEN_TESTS_MISSING");
      const ensureFrozen = (candidate: Snapshot) => {
        if (frozenHash(candidate, repo.protectedPaths) !== protectedHash) throw new DevkitError("FROZEN_TESTS_CHANGED");
        assertScope(baseline, candidate, repo.allowedPaths);
      };
      stage("reproduce");
      let reproduced = false;
      for (const check of checks) {
        const result = await runCommand(check, work, signal); stopped = result.stopped;
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
        const request: ExecutionRequest = { task: this.store.get(id), workspace: work, snapshot: capture(), feedback, signal };
        set({}, "executor_dispatch", { operationId: randomUUID(), attempt: this.store.get(id).retryCount + 1, snapshotId: request.snapshot.id });
        stopped = false;
        const executed = await executor.execute(request); stopped = executed.stopped;
        if (!stopped) throw new DevkitError("STOP_UNCONFIRMED");
        set({}, "executor_settled", { runId: executed.runId, stopped });
        stage("snapshot");
        const candidate = capture(); ensureFrozen(candidate);
        set({ snapshotId: candidate.id }, "snapshot", candidate);
        stage("verify");
        const evidence: CheckEvidence[] = []; let failed = false;
        for (const check of checks) {
          if (capture().id !== candidate.id) throw new DevkitError("STALE_SNAPSHOT");
          const result = await runCommand(check, work, signal); stopped = result.stopped;
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
  resume(id: string): never {
    this.store.get(id);
    // Never infer quiescence from a PID/heartbeat or reset the durable retry budget.
    throw new DevkitError("RECOVERY_REQUIRES_OPERATOR", "Reconcile persisted leases and workspace before creating a new task; automatic resume is not yet implemented.");
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

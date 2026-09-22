import { randomUUID } from "node:crypto";
import { DevkitError, hash, object, text } from "../contracts/task.js";
import type { RecoveryAuthorization, RecoveryAuthority, RecoveryInspection, RecoveryWorkspaceState } from "../plugins/tasks.js";

export interface RecoveryApprovalRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly workspaceState: RecoveryWorkspaceState;
  readonly policyCurrent: boolean;
  readonly baseAvailable: boolean;
  readonly expectedSnapshotId?: string;
  readonly observedSnapshotId?: string;
}

export interface PendingRecoveryApproval {
  readonly approvalId: string;
  readonly request: RecoveryApprovalRequest;
  readonly expiresAt: string;
}

/** Input accepted only from an authenticated host presentation layer. */
export interface RecoveryApprovalAuthorization {
  readonly approvalId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly decision: "accept" | "decline";
  readonly oldWriterStopped?: boolean;
  readonly operatorId: string;
}

export interface RecoveryApprovalAudit {
  readonly approvalHash: string;
  readonly taskId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly decision: "accept" | "decline";
  readonly operatorId: string;
  readonly resolvedAt: string;
  readonly reason: "operator" | "expired" | "closed";
}

export type RecoveryApprovalResolution =
  | { readonly state: "accepted"; readonly audit: RecoveryApprovalAudit }
  | { readonly state: "not-pending" }
  | { readonly state: "binding-mismatch" }
  | { readonly state: "expired" };

export interface LocalRecoveryApprovalBrokerOptions {
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  readonly maxAuditEntries?: number;
  readonly now?: () => Date;
}

interface Entry {
  readonly pending: PendingRecoveryApproval;
  readonly resolve: (authorization: RecoveryAuthorization) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  settled: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING = 32;
const DEFAULT_MAX_AUDIT_ENTRIES = 1024;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedCount(value: number | undefined, fallback: number, code: string): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new DevkitError(code);
  return count;
}

function operatorId(value: unknown): string {
  const parsed = text(value, "recovery.operatorId", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(parsed)) throw new DevkitError("INVALID_RECOVERY_APPROVAL_OPERATOR");
  return parsed;
}

function fingerprint(value: unknown, field: string): string {
  const parsed = text(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new DevkitError("INVALID_RECOVERY_APPROVAL_FINGERPRINT");
  return parsed;
}

function authorization(value: unknown): RecoveryApprovalAuthorization {
  const record = object(value, ["approvalId", "taskId", "runId", "fingerprint", "decision", "oldWriterStopped", "operatorId"]);
  if (record.decision !== "accept" && record.decision !== "decline") throw new DevkitError("INVALID_RECOVERY_APPROVAL_DECISION");
  if (record.oldWriterStopped !== undefined && typeof record.oldWriterStopped !== "boolean") throw new DevkitError("INVALID_RECOVERY_APPROVAL_PROOF");
  if (record.decision === "accept" && record.oldWriterStopped !== true) throw new DevkitError("RECOVERY_APPROVAL_PROOF_REQUIRED");
  return {
    approvalId: text(record.approvalId, "recovery.approvalId", 200),
    taskId: text(record.taskId, "recovery.taskId", 200),
    runId: text(record.runId, "recovery.runId", 200),
    fingerprint: fingerprint(record.fingerprint, "recovery.fingerprint"),
    decision: record.decision,
    ...(record.oldWriterStopped === undefined ? {} : { oldWriterStopped: record.oldWriterStopped }),
    operatorId: operatorId(record.operatorId),
  };
}

function requestFor(inspection: RecoveryInspection): RecoveryApprovalRequest {
  const taskId = text(inspection.task.taskId, "recovery.taskId", 200);
  const runId = text(inspection.lease.runId, "recovery.runId", 200);
  const request: RecoveryApprovalRequest = {
    taskId,
    runId,
    fingerprint: fingerprint(inspection.fingerprint, "recovery.fingerprint"),
    workspaceState: inspection.workspaceState,
    policyCurrent: inspection.policyCurrent === true,
    baseAvailable: inspection.baseAvailable === true,
    ...(inspection.expectedSnapshotId === undefined ? {} : { expectedSnapshotId: fingerprint(inspection.expectedSnapshotId, "recovery.expectedSnapshotId") }),
    ...(inspection.observedSnapshotId === undefined ? {} : { observedSnapshotId: fingerprint(inspection.observedSnapshotId, "recovery.observedSnapshotId") }),
  };
  if (!(["not-created", "unchanged", "changed", "untracked", "unreadable"] as const).includes(request.workspaceState)) throw new DevkitError("INVALID_RECOVERY_INSPECTION");
  return request;
}

/**
 * A bounded host-only recovery queue. Its decision proves neither process
 * termination nor identity by itself; the UI requires a separate human proof
 * and Devkit rechecks all durable facts before it releases the retained lease.
 */
export class LocalRecoveryApprovalBroker implements RecoveryAuthority {
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxAuditEntries: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, Entry>();
  private readonly auditLog: RecoveryApprovalAudit[] = [];
  private closed = false;

  constructor(options: LocalRecoveryApprovalBrokerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60 * 1000) throw new DevkitError("INVALID_RECOVERY_APPROVAL_TIMEOUT");
    this.timeoutMs = timeoutMs;
    this.maxPending = boundedCount(options.maxPending, DEFAULT_MAX_PENDING, "INVALID_RECOVERY_APPROVAL_MAX_PENDING");
    this.maxAuditEntries = boundedCount(options.maxAuditEntries, DEFAULT_MAX_AUDIT_ENTRIES, "INVALID_RECOVERY_APPROVAL_MAX_AUDIT");
    this.now = options.now ?? (() => new Date());
  }

  async authorizeRecovery(inspection: RecoveryInspection): Promise<RecoveryAuthorization> {
    if (this.closed) throw new DevkitError("RECOVERY_APPROVAL_CLOSED");
    if (this.entries.size >= this.maxPending) throw new DevkitError("RECOVERY_APPROVAL_CAPACITY");
    const request = requestFor(inspection);
    const current = this.currentDate();
    const expiresAt = new Date(current.getTime() + this.timeoutMs).toISOString();
    const approvalId = randomUUID();
    const pending = deepFreeze({ approvalId, request, expiresAt });
    return await new Promise<RecoveryAuthorization>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(approvalId, "decline", "expired"), this.timeoutMs);
      this.entries.set(approvalId, { pending, resolve, reject, timer, settled: false });
    });
  }

  pending(): readonly PendingRecoveryApproval[] {
    return [...this.entries.values()].map(entry => entry.pending).sort((left, right) => left.expiresAt < right.expiresAt ? -1 : left.expiresAt > right.expiresAt ? 1 : 0);
  }

  audit(): readonly RecoveryApprovalAudit[] {
    return [...this.auditLog];
  }

  /** Called only by a trusted, authenticated host presentation layer. */
  resolve(raw: unknown): RecoveryApprovalResolution {
    const decision = authorization(raw);
    const entry = this.entries.get(decision.approvalId);
    if (entry === undefined || entry.settled) return { state: "not-pending" };
    const current = this.currentDate();
    if (Date.parse(entry.pending.expiresAt) <= current.getTime()) {
      this.settle(decision.approvalId, "decline", "expired");
      return { state: "expired" };
    }
    const request = entry.pending.request;
    if (request.taskId !== decision.taskId || request.runId !== decision.runId || request.fingerprint !== decision.fingerprint) return { state: "binding-mismatch" };
    const audit = this.settle(decision.approvalId, decision.decision, "operator", decision.operatorId);
    return audit === undefined ? { state: "not-pending" } : { state: "accepted", audit };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.entries.keys()]) this.settle(approvalId, "decline", "closed");
  }

  private settle(
    approvalId: string,
    decision: "accept" | "decline",
    reason: RecoveryApprovalAudit["reason"],
    operatorId = "system",
  ): RecoveryApprovalAudit | undefined {
    const entry = this.entries.get(approvalId);
    if (entry === undefined || entry.settled) return undefined;
    entry.settled = true;
    this.entries.delete(approvalId);
    clearTimeout(entry.timer);
    const audit: RecoveryApprovalAudit = Object.freeze({
      approvalHash: hash(approvalId),
      taskId: entry.pending.request.taskId,
      runId: entry.pending.request.runId,
      fingerprint: entry.pending.request.fingerprint,
      decision,
      operatorId,
      resolvedAt: this.currentDate().toISOString(),
      reason,
    });
    this.auditLog.push(audit);
    if (this.auditLog.length > this.maxAuditEntries) this.auditLog.splice(0, this.auditLog.length - this.maxAuditEntries);
    if (decision === "accept") {
      entry.resolve({
        action: "retry-from-base",
        taskId: entry.pending.request.taskId,
        runId: entry.pending.request.runId,
        fingerprint: entry.pending.request.fingerprint,
        approvalId,
        oldWriterStopped: true,
      });
    } else {
      entry.reject(new DevkitError(reason === "expired" ? "RECOVERY_APPROVAL_EXPIRED" : reason === "closed" ? "RECOVERY_APPROVAL_CLOSED" : "RECOVERY_APPROVAL_DECLINED"));
    }
    return audit;
  }

  private currentDate(): Date {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new DevkitError("INVALID_RECOVERY_APPROVAL_CLOCK");
    return new Date(current.getTime());
  }
}

export function createLocalRecoveryApprovalBroker(options: LocalRecoveryApprovalBrokerOptions = {}): LocalRecoveryApprovalBroker {
  return new LocalRecoveryApprovalBroker(options);
}

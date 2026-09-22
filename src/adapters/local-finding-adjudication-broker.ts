import { randomUUID } from "node:crypto";
import { DevkitError, hash, object, text } from "../contracts/task.js";
import { redact } from "../domain/security.js";
import type { FindingAdjudicationAuthorization, FindingAdjudicationInspection, FindingAdjudicator } from "../plugins/tasks.js";

export interface FindingSummary {
  readonly severity: "P0" | "P1";
  readonly title: string;
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
  readonly trigger: string;
  readonly impact: string;
  readonly evidence: readonly string[];
}

export interface FindingAdjudicationRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly findingFingerprint: string;
  readonly fingerprint: string;
  readonly finding: FindingSummary;
}

export interface PendingFindingAdjudication {
  readonly approvalId: string;
  readonly request: FindingAdjudicationRequest;
  readonly expiresAt: string;
}

/** Input accepted only from the authenticated local presentation layer. */
export interface FindingAdjudicationApproval {
  readonly approvalId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly findingFingerprint: string;
  readonly fingerprint: string;
  readonly action: "confirm" | "defer";
  readonly operatorId: string;
}

export interface FindingAdjudicationAudit {
  readonly approvalHash: string;
  readonly taskId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly findingFingerprint: string;
  readonly action: "confirm" | "defer";
  readonly operatorId: string;
  readonly resolvedAt: string;
  readonly reason: "operator" | "expired" | "aborted" | "closed";
}

export type FindingAdjudicationResolution =
  | { readonly state: "accepted"; readonly audit: FindingAdjudicationAudit }
  | { readonly state: "not-pending" }
  | { readonly state: "binding-mismatch" }
  | { readonly state: "expired" };

export interface LocalFindingAdjudicationBrokerOptions {
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  readonly maxAuditEntries?: number;
  readonly now?: () => Date;
}

interface Entry {
  readonly pending: PendingFindingAdjudication;
  readonly resolve: (authorization: FindingAdjudicationAuthorization) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
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

function hex(value: unknown, field: string): string {
  const parsed = text(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new DevkitError("INVALID_FINDING_ADJUDICATION_FINGERPRINT");
  return parsed;
}

function operatorId(value: unknown): string {
  const parsed = text(value, "adjudication.operatorId", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(parsed)) throw new DevkitError("INVALID_FINDING_ADJUDICATION_OPERATOR");
  return parsed;
}

function display(value: unknown, field: string, sourceLimit: number, displayLimit: number): string {
  const redacted = redact(text(value, field, sourceLimit));
  return redacted.length <= displayLimit ? redacted : `${redacted.slice(0, Math.max(1, displayLimit - 1))}…`;
}

function summary(value: unknown): FindingSummary {
  const finding = object(value, ["severity", "title", "path", "line", "ruleId", "trigger", "impact", "evidence", "fingerprint"]);
  if ((finding.severity !== "P0" && finding.severity !== "P1") || !Number.isSafeInteger(finding.line) || Number(finding.line) < 1 || !Array.isArray(finding.evidence) || finding.evidence.length > 100) throw new DevkitError("INVALID_FINDING_ADJUDICATION_REQUEST");
  hex(finding.fingerprint, "adjudication.findingFingerprint");
  return {
    severity: finding.severity,
    title: display(finding.title, "adjudication.title", 300, 300),
    path: display(finding.path, "adjudication.path", 500, 500),
    line: Number(finding.line),
    ruleId: display(finding.ruleId, "adjudication.ruleId", 100, 100),
    trigger: display(finding.trigger, "adjudication.trigger", 12_000, 1_000),
    impact: display(finding.impact, "adjudication.impact", 12_000, 1_000),
    evidence: finding.evidence.slice(0, 8).map((entry, index) => display(entry, `adjudication.evidence[${index}]`, 12_000, 1_000)),
  };
}

function requestFor(value: unknown): FindingAdjudicationRequest {
  const inspection = object(value, ["taskId", "runId", "taskVersion", "snapshotId", "finding", "fingerprint"]);
  if (!Number.isSafeInteger(inspection.taskVersion) || Number(inspection.taskVersion) < 0) throw new DevkitError("INVALID_FINDING_ADJUDICATION_REQUEST");
  const finding = summary(inspection.finding);
  const rawFinding = object(inspection.finding, ["severity", "title", "path", "line", "ruleId", "trigger", "impact", "evidence", "fingerprint"]);
  return {
    taskId: text(inspection.taskId, "adjudication.taskId", 100),
    runId: text(inspection.runId, "adjudication.runId", 100),
    snapshotId: hex(inspection.snapshotId, "adjudication.snapshotId"),
    findingFingerprint: hex(rawFinding.fingerprint, "adjudication.findingFingerprint"),
    fingerprint: hex(inspection.fingerprint, "adjudication.fingerprint"),
    finding,
  };
}

function approval(value: unknown): FindingAdjudicationApproval {
  const record = object(value, ["approvalId", "taskId", "runId", "snapshotId", "findingFingerprint", "fingerprint", "action", "operatorId"]);
  if (record.action !== "confirm" && record.action !== "defer") throw new DevkitError("INVALID_FINDING_ADJUDICATION_ACTION");
  return {
    approvalId: text(record.approvalId, "adjudication.approvalId", 200),
    taskId: text(record.taskId, "adjudication.taskId", 100),
    runId: text(record.runId, "adjudication.runId", 100),
    snapshotId: hex(record.snapshotId, "adjudication.snapshotId"),
    findingFingerprint: hex(record.findingFingerprint, "adjudication.findingFingerprint"),
    fingerprint: hex(record.fingerprint, "adjudication.fingerprint"),
    action: record.action,
    operatorId: operatorId(record.operatorId),
  };
}

/**
 * Bounded host-only queue for high-risk findings. A confirmed decision never
 * accepts delivery: it only allows the existing retry path. Deferral remains
 * fail-closed and leaves the task awaiting human judgement.
 */
export class LocalFindingAdjudicationBroker implements FindingAdjudicator {
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxAuditEntries: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, Entry>();
  private readonly auditLog: FindingAdjudicationAudit[] = [];
  private closed = false;

  constructor(options: LocalFindingAdjudicationBrokerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60 * 1000) throw new DevkitError("INVALID_FINDING_ADJUDICATION_TIMEOUT");
    this.timeoutMs = timeoutMs;
    this.maxPending = boundedCount(options.maxPending, DEFAULT_MAX_PENDING, "INVALID_FINDING_ADJUDICATION_MAX_PENDING");
    this.maxAuditEntries = boundedCount(options.maxAuditEntries, DEFAULT_MAX_AUDIT_ENTRIES, "INVALID_FINDING_ADJUDICATION_MAX_AUDIT");
    this.now = options.now ?? (() => new Date());
  }

  async authorizeFinding(inspection: FindingAdjudicationInspection, signal: AbortSignal): Promise<FindingAdjudicationAuthorization> {
    if (this.closed) throw new DevkitError("FINDING_ADJUDICATION_CLOSED");
    signal.throwIfAborted();
    if (this.entries.size >= this.maxPending) throw new DevkitError("FINDING_ADJUDICATION_CAPACITY");
    const request = requestFor(inspection);
    const current = this.currentDate();
    const approvalId = randomUUID();
    const pending = deepFreeze({ approvalId, request, expiresAt: new Date(current.getTime() + this.timeoutMs).toISOString() });
    return await new Promise<FindingAdjudicationAuthorization>(resolve => {
      const onAbort = () => this.settle(approvalId, "defer", "aborted");
      const timer = setTimeout(() => this.settle(approvalId, "defer", "expired"), this.timeoutMs);
      this.entries.set(approvalId, { pending, resolve, timer, signal, onAbort, settled: false });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) this.settle(approvalId, "defer", "aborted");
    });
  }

  pending(): readonly PendingFindingAdjudication[] {
    return [...this.entries.values()].map(entry => entry.pending).sort((left, right) => left.expiresAt.localeCompare(right.expiresAt));
  }

  audit(): readonly FindingAdjudicationAudit[] {
    return [...this.auditLog];
  }

  /** Called only by the authenticated host presentation layer. */
  resolve(raw: unknown): FindingAdjudicationResolution {
    const decision = approval(raw);
    const entry = this.entries.get(decision.approvalId);
    if (entry === undefined || entry.settled) return { state: "not-pending" };
    if (Date.parse(entry.pending.expiresAt) <= this.currentDate().getTime()) {
      this.settle(decision.approvalId, "defer", "expired");
      return { state: "expired" };
    }
    const request = entry.pending.request;
    if (request.taskId !== decision.taskId || request.runId !== decision.runId || request.snapshotId !== decision.snapshotId || request.findingFingerprint !== decision.findingFingerprint || request.fingerprint !== decision.fingerprint) return { state: "binding-mismatch" };
    const audit = this.settle(decision.approvalId, decision.action, "operator", decision.operatorId);
    return audit === undefined ? { state: "not-pending" } : { state: "accepted", audit };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.entries.keys()]) this.settle(approvalId, "defer", "closed");
  }

  private settle(
    approvalId: string,
    action: "confirm" | "defer",
    reason: FindingAdjudicationAudit["reason"],
    operatorId = "system",
  ): FindingAdjudicationAudit | undefined {
    const entry = this.entries.get(approvalId);
    if (entry === undefined || entry.settled) return undefined;
    entry.settled = true;
    this.entries.delete(approvalId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    const audit = Object.freeze({
      approvalHash: hash(approvalId),
      taskId: entry.pending.request.taskId,
      runId: entry.pending.request.runId,
      snapshotId: entry.pending.request.snapshotId,
      findingFingerprint: entry.pending.request.findingFingerprint,
      action,
      operatorId,
      resolvedAt: this.currentDate().toISOString(),
      reason,
    });
    this.auditLog.push(audit);
    if (this.auditLog.length > this.maxAuditEntries) this.auditLog.splice(0, this.auditLog.length - this.maxAuditEntries);
    entry.resolve({
      action,
      taskId: entry.pending.request.taskId,
      runId: entry.pending.request.runId,
      snapshotId: entry.pending.request.snapshotId,
      findingFingerprint: entry.pending.request.findingFingerprint,
      fingerprint: entry.pending.request.fingerprint,
      approvalId,
    });
    return audit;
  }

  private currentDate(): Date {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new DevkitError("INVALID_FINDING_ADJUDICATION_CLOCK");
    return new Date(current.getTime());
  }
}

export function createLocalFindingAdjudicationBroker(options: LocalFindingAdjudicationBrokerOptions = {}): LocalFindingAdjudicationBroker {
  return new LocalFindingAdjudicationBroker(options);
}

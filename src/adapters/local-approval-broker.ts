import { randomUUID } from "node:crypto";
import { DevkitError, hash, object, text } from "../contracts/task.js";
import type { CodexAppServerApprovalBroker, CodexAppServerApprovalRequest } from "./codex-app-server-client.js";

export interface PendingCodexApproval {
  readonly approvalId: string;
  readonly request: CodexAppServerApprovalRequest;
  readonly expiresAt: string;
}

/**
 * Input accepted only from a host-authenticated presentation layer. This class
 * validates binding and expiry, but deliberately does not pretend that an
 * arbitrary caller-supplied `operatorId` proves human identity.
 */
export interface CodexApprovalAuthorization {
  readonly approvalId: string;
  readonly taskId: string;
  readonly fingerprint: string;
  readonly decision: "accept" | "decline";
  readonly operatorId: string;
}

export interface CodexApprovalAudit {
  readonly approvalHash: string;
  readonly taskId: string;
  readonly fingerprint: string;
  readonly decision: "accept" | "decline";
  readonly operatorId: string;
  readonly resolvedAt: string;
  readonly reason: "operator" | "expired" | "aborted" | "closed";
}

export type CodexApprovalResolution =
  | { readonly state: "accepted"; readonly audit: CodexApprovalAudit }
  | { readonly state: "not-pending" }
  | { readonly state: "binding-mismatch" }
  | { readonly state: "expired" };

export interface LocalCodexApprovalBrokerOptions {
  /** A single request cannot remain pending indefinitely. */
  readonly timeoutMs?: number;
  /** Saturation declines new requests instead of retaining unbounded state. */
  readonly maxPending?: number;
  /** Audit evidence is useful, but must not become an unbounded memory sink. */
  readonly maxAuditEntries?: number;
  readonly now?: () => Date;
}

interface Entry {
  readonly pending: PendingCodexApproval;
  readonly resolve: (decision: "accept" | "decline") => void;
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

function parseAuthorization(value: unknown): CodexApprovalAuthorization {
  const record = object(value, ["approvalId", "taskId", "fingerprint", "decision", "operatorId"]);
  const decision = record.decision;
  if (decision !== "accept" && decision !== "decline") throw new Error("INVALID_CODEX_APPROVAL_DECISION");
  return {
    approvalId: text(record.approvalId, "approval.approvalId", 200),
    taskId: text(record.taskId, "approval.taskId", 200),
    fingerprint: text(record.fingerprint, "approval.fingerprint", 200),
    decision,
    operatorId: operatorId(record.operatorId),
  };
}

function operatorId(value: unknown): string {
  const parsed = text(value, "approval.operatorId", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(parsed)) throw new DevkitError("INVALID_CODEX_APPROVAL_OPERATOR");
  return parsed;
}

function approvalRequest(value: unknown): CodexAppServerApprovalRequest {
  const record = object(value, ["taskId", "kind", "requestId", "threadId", "turnId", "itemId", "fingerprint", "cwd", "reason", "command", "paths"]);
  if (record.kind !== "command" && record.kind !== "file-change") throw new DevkitError("INVALID_CODEX_APPROVAL_KIND");
  const fingerprint = text(record.fingerprint, "approval.fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new DevkitError("INVALID_CODEX_APPROVAL_FINGERPRINT");
  const common = {
    taskId: text(record.taskId, "approval.taskId", 200),
    kind: record.kind,
    requestId: text(record.requestId, "approval.requestId", 200),
    threadId: text(record.threadId, "approval.threadId", 200),
    turnId: text(record.turnId, "approval.turnId", 200),
    itemId: text(record.itemId, "approval.itemId", 200),
    fingerprint,
    cwd: text(record.cwd, "approval.cwd", 4096),
    ...(record.reason === undefined ? {} : { reason: text(record.reason, "approval.reason", 4096) }),
  } as const;
  if (record.kind === "command") {
    if (record.paths !== undefined) throw new DevkitError("INVALID_CODEX_APPROVAL_COMMAND");
    return { ...common, kind: "command", command: text(record.command, "approval.command", 16 * 1024) };
  }
  if (record.command !== undefined || !Array.isArray(record.paths) || record.paths.length < 1 || record.paths.length > 100) throw new DevkitError("INVALID_CODEX_APPROVAL_FILE_CHANGE");
  const paths = record.paths.map((item, index) => text(item, `approval.paths[${index}]`, 4096));
  if (new Set(paths).size !== paths.length) throw new DevkitError("DUPLICATE_CODEX_APPROVAL_PATH");
  return { ...common, kind: "file-change", paths };
}

function boundedCount(value: number | undefined, fallback: number, code: string): number {
  const count = value ?? fallback;
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new DevkitError(code);
  return count;
}

/**
 * In-memory, host-only approval queue. It is safe to hand to the direct App
 * Server client because a model sees neither a pending approval ID nor the
 * `resolve()` method. Plugin restart is intentionally fail-closed: active
 * writers become interrupted and every pending item disappears with decline.
 */
export class LocalCodexApprovalBroker implements CodexAppServerApprovalBroker {
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxAuditEntries: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, Entry>();
  private readonly auditLog: CodexApprovalAudit[] = [];
  private closed = false;

  constructor(options: LocalCodexApprovalBrokerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60 * 1000) throw new Error("INVALID_CODEX_APPROVAL_TIMEOUT");
    this.timeoutMs = timeoutMs;
    this.maxPending = boundedCount(options.maxPending, DEFAULT_MAX_PENDING, "INVALID_CODEX_APPROVAL_MAX_PENDING");
    this.maxAuditEntries = boundedCount(options.maxAuditEntries, DEFAULT_MAX_AUDIT_ENTRIES, "INVALID_CODEX_APPROVAL_MAX_AUDIT");
    this.now = options.now ?? (() => new Date());
  }

  async decide(request: CodexAppServerApprovalRequest, signal: AbortSignal): Promise<"accept" | "decline"> {
    if (this.closed || signal.aborted || this.entries.size >= this.maxPending) return "decline";
    const approvedRequest = approvalRequest(request);
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new DevkitError("INVALID_CODEX_APPROVAL_CLOCK");
    const created = new Date(current.getTime());
    const expires = new Date(created.getTime() + this.timeoutMs);
    const approvalId = randomUUID();
    const pending: PendingCodexApproval = deepFreeze({
      approvalId,
      request: approvedRequest,
      expiresAt: expires.toISOString(),
    });
    return await new Promise<"accept" | "decline">(resolve => {
      const onAbort = () => this.settle(approvalId, "decline", "aborted");
      const timer = setTimeout(() => this.settle(approvalId, "decline", "expired"), this.timeoutMs);
      const entry: Entry = { pending, resolve, timer, signal, onAbort, settled: false };
      this.entries.set(approvalId, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      // The signal may have changed between the initial check and listener
      // registration. Resolve it through the same single-settlement path.
      if (signal.aborted) this.settle(approvalId, "decline", "aborted");
    });
  }

  pending(): readonly PendingCodexApproval[] {
    return [...this.entries.values()].map(entry => entry.pending).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  audit(): readonly CodexApprovalAudit[] {
    return [...this.auditLog];
  }

  /** Called only by a trusted, authenticated host presentation layer. */
  resolve(raw: unknown): CodexApprovalResolution {
    const authorization = parseAuthorization(raw);
    const entry = this.entries.get(authorization.approvalId);
    if (entry === undefined || entry.settled) return { state: "not-pending" };
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new DevkitError("INVALID_CODEX_APPROVAL_CLOCK");
    if (Date.parse(entry.pending.expiresAt) <= current.getTime()) {
      this.settle(authorization.approvalId, "decline", "expired");
      return { state: "expired" };
    }
    if (entry.pending.request.taskId !== authorization.taskId || entry.pending.request.fingerprint !== authorization.fingerprint) {
      return { state: "binding-mismatch" };
    }
    const audit = this.settle(authorization.approvalId, authorization.decision, "operator", authorization.operatorId);
    return audit === undefined ? { state: "not-pending" } : { state: "accepted", audit };
  }

  /** Plugin shutdown and test teardown must not strand a live writer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.entries.keys()]) this.settle(approvalId, "decline", "closed");
  }

  private settle(
    approvalId: string,
    decision: "accept" | "decline",
    reason: CodexApprovalAudit["reason"],
    operatorId = "system",
  ): CodexApprovalAudit | undefined {
    const entry = this.entries.get(approvalId);
    if (entry === undefined || entry.settled) return undefined;
    const resolvedAt = this.currentTimestamp();
    entry.settled = true;
    this.entries.delete(approvalId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    const audit: CodexApprovalAudit = {
      approvalHash: hash(approvalId),
      taskId: entry.pending.request.taskId,
      fingerprint: entry.pending.request.fingerprint,
      decision,
      operatorId,
      resolvedAt,
      reason,
    };
    this.auditLog.push(Object.freeze(audit));
    if (this.auditLog.length > this.maxAuditEntries) this.auditLog.splice(0, this.auditLog.length - this.maxAuditEntries);
    entry.resolve(decision);
    return audit;
  }

  private currentTimestamp(): string {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new DevkitError("INVALID_CODEX_APPROVAL_CLOCK");
    return new Date(current.getTime()).toISOString();
  }
}

export function createLocalCodexApprovalBroker(options: LocalCodexApprovalBrokerOptions = {}): LocalCodexApprovalBroker {
  return new LocalCodexApprovalBroker(options);
}

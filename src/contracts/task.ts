import { createHash } from "node:crypto";

export const TASK_SCHEMA_VERSION = 1 as const;
export type TaskKind = "bugfix" | "ui-fix" | "feature";
export type TaskStatus = "queued" | "running" | "blocked" | "awaiting_human" | "cancelling" | "cancelled" | "interrupted" | "failed" | "completed";
export type TaskStage = "preflight" | "context" | "reproduce" | "implement" | "snapshot" | "verify" | "review" | "triage" | "package";
export interface AcceptanceCriterion { readonly id: string; readonly description: string }
export interface TaskInput {
  readonly kind: TaskKind; readonly title: string; readonly description: string;
  readonly repositoryRef: string; readonly baseRef?: string;
  readonly reproduction: { readonly steps: string[]; readonly expected: string; readonly actual: string };
  readonly acceptanceCriteria: AcceptanceCriterion[]; readonly verificationProfile: string;
  readonly contextRefs?: string[]; readonly idempotencyKey?: string;
}
/** Metadata only; frozen context text is stored in a private host artifact. */
export interface FrozenContextFile { readonly path: string; readonly hash: string; readonly size: number }
export interface FrozenContext {
  readonly schemaVersion: 1;
  readonly baseCommit: string;
  readonly manifestHash: string;
  readonly files: readonly FrozenContextFile[];
}
export interface TaskRecord {
  readonly schemaVersion: 1; readonly taskId: string; readonly inputHash: string;
  readonly input: TaskInput; readonly status: TaskStatus; readonly stage: TaskStage;
  readonly retryCount: number; readonly readyForAcceptance: boolean; readonly reason?: string;
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
  readonly policyHash: string; readonly baseCommit?: string; readonly workspace?: string;
  readonly snapshotId?: string; readonly runId?: string; readonly frozenContext?: FrozenContext;
}
export class DevkitError extends Error {
  constructor(readonly code: string, detail = "") { super(detail ? `${code}: ${detail}` : code); this.name = "DevkitError"; }
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new DevkitError("INVALID_OBJECT");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new DevkitError("UNKNOWN_FIELD", key);
  return record;
}
export function text(value: unknown, field: string, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new DevkitError("INVALID_FIELD", field);
  return value;
}
export function strings(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 100) throw new DevkitError("INVALID_FIELD", field);
  return value.map((item) => text(item, field));
}

/** A task may name only individual, portable repository-relative files. */
export function contextReference(value: unknown, field: string, allowDirectory = false): string {
  const reference = text(value, field, 512);
  const directory = allowDirectory && reference.endsWith("/");
  const candidate = directory ? reference.slice(0, -1) : reference;
  if (!candidate || reference.startsWith("/") || reference.includes("\\") || reference.includes(":") || /[\u0000-\u001f\u007f]/.test(reference) || (!directory && reference.endsWith("/")) || candidate.split("/").some(part => !part || part === "." || part === "..")) {
    throw new DevkitError("INVALID_CONTEXT_REFERENCE", field);
  }
  return directory ? `${candidate}/` : candidate;
}

function contextReferences(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) throw new DevkitError("INVALID_CONTEXT_REFERENCES");
  const references = value.map((item, index) => contextReference(item, `contextRefs[${index}]`));
  if (new Set(references).size !== references.length) throw new DevkitError("DUPLICATE_CONTEXT_REFERENCE");
  return references.sort();
}

export function validateTaskInput(value: unknown): TaskInput {
  const r = object(value, ["kind", "title", "description", "repositoryRef", "baseRef", "reproduction", "acceptanceCriteria", "verificationProfile", "contextRefs", "idempotencyKey"]);
  if (r.kind !== "bugfix") throw new DevkitError("UNSUPPORTED_TASK_KIND");
  const reproduction = object(r.reproduction, ["steps", "expected", "actual"]);
  if (!Array.isArray(r.acceptanceCriteria) || !r.acceptanceCriteria.length || r.acceptanceCriteria.length > 100) throw new DevkitError("MISSING_ACCEPTANCE_CRITERIA");
  const criteria = r.acceptanceCriteria.map((item) => {
    const criterion = object(item, ["id", "description"]);
    return { id: text(criterion.id, "criterion.id", 100), description: text(criterion.description, "criterion.description") };
  });
  if (new Set(criteria.map((c) => c.id)).size !== criteria.length) throw new DevkitError("DUPLICATE_CRITERION_ID");
  return {
    kind: "bugfix", title: text(r.title, "title", 200), description: text(r.description, "description"),
    repositoryRef: text(r.repositoryRef, "repositoryRef", 100), verificationProfile: text(r.verificationProfile, "verificationProfile", 100),
    reproduction: { steps: strings(reproduction.steps, "reproduction.steps"), expected: text(reproduction.expected, "reproduction.expected"), actual: text(reproduction.actual, "reproduction.actual") },
    acceptanceCriteria: criteria,
    ...(r.baseRef === undefined ? {} : { baseRef: text(r.baseRef, "baseRef", 200) }),
    ...(r.contextRefs === undefined ? {} : { contextRefs: contextReferences(r.contextRefs) }),
    ...(r.idempotencyKey === undefined ? {} : { idempotencyKey: text(r.idempotencyKey, "idempotencyKey", 200) }),
  };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value); if (result === undefined) throw new DevkitError("NON_JSON_VALUE"); return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r).sort().map((key) => `${JSON.stringify(key)}:${canonical(r[key])}`).join(",")}}`;
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function byteHash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

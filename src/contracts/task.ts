export const TASK_SCHEMA_VERSION = 1 as const;

export type TaskKind = "bugfix" | "ui-fix" | "feature";
export type TaskStatus = "queued" | "running" | "blocked" | "awaiting_human" | "cancelling" | "cancelled" | "interrupted" | "failed" | "completed";
export type TaskStage = "preflight" | "context" | "reproduce" | "implement" | "snapshot" | "verify" | "review" | "triage" | "package";

export interface AcceptanceCriterion { readonly id: string; readonly description: string; }
export interface TaskInput {
  readonly kind: TaskKind;
  readonly title: string;
  readonly description: string;
  readonly repositoryRef: string;
  readonly baseRef?: string;
  readonly reproduction: { readonly steps: string[]; readonly expected: string; readonly actual: string; };
  readonly acceptanceCriteria: AcceptanceCriterion[];
  readonly verificationProfile: string;
  readonly contextRefs?: string[];
  readonly idempotencyKey?: string;
}
export interface TaskRecord {
  readonly schemaVersion: typeof TASK_SCHEMA_VERSION;
  readonly taskId: string;
  readonly inputHash: string;
  readonly input: TaskInput;
  readonly status: TaskStatus;
  readonly stage: TaskStage;
  readonly retryCount: number;
  readonly readyForAcceptance: boolean;
  readonly reason?: string;
}

export function validateTaskInput(value: unknown): TaskInput {
  if (!value || typeof value !== "object") throw new Error("INVALID_TASK_INPUT");
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "bugfix") throw new Error("UNSUPPORTED_TASK_KIND");
  for (const key of ["title", "description", "repositoryRef", "verificationProfile"]) {
    if (typeof input[key] !== "string" || input[key] === "") throw new Error(`MISSING_${key.toUpperCase()}`);
  }
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) throw new Error("MISSING_ACCEPTANCE_CRITERIA");
  const reproduction = input.reproduction;
  if (!reproduction || typeof reproduction !== "object") throw new Error("MISSING_REPRODUCTION");
  const r = reproduction as Record<string, unknown>;
  if (!Array.isArray(r.steps) || typeof r.expected !== "string" || typeof r.actual !== "string") throw new Error("INVALID_REPRODUCTION");
  return structuredClone(input) as unknown as TaskInput;
}

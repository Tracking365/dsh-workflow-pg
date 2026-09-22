import type { TaskStage, TaskStatus } from "../contracts/task.js";
import { DevkitError } from "../contracts/task.js";
const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"], running: ["blocked", "awaiting_human", "cancelling", "interrupted", "failed", "running"],
  blocked: ["queued", "cancelled", "awaiting_human"], awaiting_human: ["completed", "queued", "cancelled"],
  cancelling: ["cancelled", "interrupted"], cancelled: [], interrupted: ["queued", "blocked", "cancelled"], failed: ["queued", "blocked", "cancelled"], completed: [],
};
export function canTransition(from: TaskStatus, to: TaskStatus): boolean { return transitions[from].includes(to); }
export function assertTransition(from: TaskStatus, to: TaskStatus): void { if (!canTransition(from, to)) throw new DevkitError("INVALID_TRANSITION", `${from}->${to}`); }
export function nextStage(stage: TaskStage, status: TaskStatus): TaskStage {
  if (status !== "running") return stage;
  const stages: TaskStage[] = ["preflight", "context", "reproduce", "implement", "snapshot", "verify", "review", "triage", "package"];
  return stages[Math.min(stages.indexOf(stage) + 1, stages.length - 1)]!;
}
export function readyForAcceptance(input: { reproduced: boolean; verificationPassed: boolean; requiredReviewPassed: boolean; blockingFindings: number; sideEffectsProvenStopped: boolean }): boolean {
  return input.reproduced && input.verificationPassed && input.requiredReviewPassed && input.blockingFindings === 0 && input.sideEffectsProvenStopped;
}
export interface CheckEvidence { readonly checkId: string; readonly snapshotId: string; readonly criteria: readonly string[]; readonly passed: boolean }
export function evidenceGate(snapshotId: string, criteria: readonly string[], requiredChecks: readonly string[], checks: readonly CheckEvidence[], review: { snapshotId: string; passed: boolean; blockingFindings: number } | undefined): boolean {
  const current = checks.filter((v) => v.snapshotId === snapshotId && v.passed);
  return requiredChecks.length > 0 && criteria.length > 0 && requiredChecks.every((id) => current.some((v) => v.checkId === id)) && criteria.every((id) => current.some((v) => v.criteria.includes(id))) && review?.snapshotId === snapshotId && review.passed && review.blockingFindings === 0;
}

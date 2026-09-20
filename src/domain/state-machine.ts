import type { TaskStage, TaskStatus } from "../contracts/task.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"], running: ["blocked", "awaiting_human", "cancelling", "failed", "running"], blocked: ["queued", "awaiting_human"], awaiting_human: ["completed", "queued"], cancelling: ["cancelled", "interrupted"], cancelled: [], interrupted: ["queued", "blocked"], failed: ["queued", "blocked"], completed: []
};
export function canTransition(from: TaskStatus, to: TaskStatus): boolean { return transitions[from].includes(to); }
export function assertTransition(from: TaskStatus, to: TaskStatus): void { if (!canTransition(from, to)) throw new Error(`INVALID_TRANSITION:${from}->${to}`); }
export function nextStage(stage: TaskStage, status: TaskStatus): TaskStage { if (status === "blocked" || status === "awaiting_human") return stage; const stages: TaskStage[] = ["preflight", "context", "reproduce", "implement", "snapshot", "verify", "review", "triage", "package"]; const i = stages.indexOf(stage); return stages[Math.min(i + 1, stages.length - 1)]!; }
export function readyForAcceptance(input: { reproduced: boolean; verificationPassed: boolean; requiredReviewPassed: boolean; blockingFindings: number; sideEffectsProvenStopped: boolean }): boolean { return input.reproduced && input.verificationPassed && input.requiredReviewPassed && input.blockingFindings === 0 && input.sideEffectsProvenStopped; }

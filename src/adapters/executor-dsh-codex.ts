import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { redact } from "../domain/security.js";
import type { CodeExecutor, ExecutionRequest, ExecutionResult } from "../plugins/tasks.js";

const MAX_PROMPT_CHARS = 24_000;
const DEFAULT_PROVIDER = "codex";

export interface DshCodexExecutorOptions {
  /** The actual DSH subagent service provided by the host profile. */
  readonly subagents: Pick<SubagentRuntime, "getProvider" | "start">;
  /** The Agent whose tool call owns the delegated Codex process. */
  readonly parent: Agent;
  /** A host-configured provider instance; default is the official `codex` provider. */
  readonly providerName?: string;
}

function clipped(value: string, limit: number): string {
  const safe = redact(value);
  return safe.length <= limit ? safe : `${safe.slice(0, limit)}\n[truncated by DevKit]`;
}

function list(values: readonly string[]): string {
  return values.length ? values.map((value) => `- ${clipped(value, 512)}`).join("\n") : "- (none)";
}

/**
 * Create the standalone text task accepted by the official DSH Codex provider.
 * The provider owns Codex App Server startup, credentials, process teardown and
 * cancellation; this adapter never invokes Codex directly.
 */
export function dshCodexPrompt(request: ExecutionRequest): ContentBlock[] {
  const { task } = request;
  const text = [
    "You are the sole code-writing subagent for a bounded DevKit bugfix task.",
    "Work only in the current workspace. Do not modify protected paths, DevKit control-plane files, Git configuration, remotes, or credentials. Do not push, merge, rebase, deploy, or use unapproved network access.",
    "Run only the minimal commands needed to understand and repair the task. Preserve the frozen regression tests. In your final response, state the files changed and the verification you actually ran; never claim success without evidence.",
    "",
    `Task ID: ${task.taskId}`,
    `Candidate snapshot: ${request.snapshot.id}`,
    `Title: ${clipped(task.input.title, 512)}`,
    "Description:",
    clipped(task.input.description, 8_000),
    "",
    "Reproduction contract:",
    ...task.input.reproduction.steps.map((step, index) => `${index + 1}. ${clipped(step, 1_024)}`),
    `Expected: ${clipped(task.input.reproduction.expected, 2_000)}`,
    `Actual: ${clipped(task.input.reproduction.actual, 2_000)}`,
    "",
    "Acceptance criteria:",
    ...task.input.acceptanceCriteria.map((criterion) => `- ${clipped(criterion.id, 100)}: ${clipped(criterion.description, 1_024)}`),
    "",
    "Allowed write paths:",
    list(request.allowedPaths),
    "Protected paths:",
    list(request.protectedPaths),
    "",
    "Feedback from the previous verification/review attempt:",
    clipped(request.feedback || "(none)", 4_000),
  ].join("\n");
  return [{ type: "text", text: clipped(text, MAX_PROMPT_CHARS) }];
}

function stopFailure(reason: string): string {
  switch (reason) {
    case "aborted": return "CODEX_SUBAGENT_ABORTED";
    case "error": return "CODEX_SUBAGENT_ERROR";
    case "max-tokens": return "CODEX_SUBAGENT_MAX_TOKENS";
    case "refusal": return "CODEX_SUBAGENT_REFUSED";
    default: return "CODEX_SUBAGENT_UNKNOWN_STOP";
  }
}

/**
 * The official provider starts Codex in `parent.session.header.cwd`; it has no
 * public per-run working-directory option. Never let a DevKit worktree and
 * that parent directory diverge merely because a prompt asks the child to use
 * the worktree.
 */
function isBoundToCandidateWorkspace(parent: Agent, workspace: string): boolean {
  const parentCwd = parent.session.header.cwd;
  if (typeof parentCwd !== "string" || !isAbsolute(parentCwd) || !isAbsolute(workspace)) return false;
  try {
    return realpathSync(parentCwd) === realpathSync(workspace);
  } catch {
    return false;
  }
}

/**
 * Live executor bridge for a DSH profile that has separately installed the
 * official `@deepseek-ai/dsh-subagent-codex` provider. It is intentionally
 * dormant under DevKit's current disabled policy until a verified sandbox is
 * added; keeping the bridge here makes that future activation explicit.
 */
export class DshCodexExecutor implements CodeExecutor {
  readonly family = "codex-app-server";
  readonly kind = "live" as const;
  private readonly providerName: string;

  constructor(private readonly options: DshCodexExecutorOptions) {
    this.providerName = options.providerName ?? DEFAULT_PROVIDER;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.signal.aborted) return { stopped: true, failure: "CANCELLED" };
    if (!isBoundToCandidateWorkspace(this.options.parent, request.workspace)) {
      return { stopped: true, failure: "CODEX_WORKSPACE_BINDING_UNAVAILABLE" };
    }
    if (this.options.subagents.getProvider(this.providerName) === undefined) {
      return { stopped: true, failure: "CODEX_PROVIDER_UNAVAILABLE" };
    }

    let run;
    try {
      run = await this.options.subagents.start(this.providerName, {
        label: `devkit:${request.task.taskId}`,
        parent: this.options.parent,
        prompt: dshCodexPrompt(request),
        signal: request.signal,
      });
    } catch {
      // The DSH provider contract guarantees unpublished startup cleanup.
      return { stopped: true, failure: "CODEX_SUBAGENT_START_FAILED" };
    }

    let failure: string | undefined;
    try {
      const result = await run.result;
      if (result.stopReason !== "completed") failure = stopFailure(String(result.stopReason));
    } catch {
      failure = "CODEX_SUBAGENT_RESULT_FAILED";
    }

    try {
      await run.dispose();
    } catch {
      return { stopped: false, runId: String(run.id), failure: "CODEX_SUBAGENT_DISPOSAL_UNCONFIRMED" };
    }
    return failure === undefined
      ? { stopped: true, runId: String(run.id) }
      : { stopped: true, runId: String(run.id), failure };
  }
}

export function createDshCodexExecutor(options: DshCodexExecutorOptions): DshCodexExecutor {
  return new DshCodexExecutor(options);
}

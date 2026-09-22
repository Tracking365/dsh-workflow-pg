import path from "node:path";
import { DevkitError } from "../contracts/task.js";
import type { CodexAppServerClientLaunch, PreparedCodexAppServerClient } from "./codex-app-server-client.js";
import type { AppServerExecutionBoundary } from "./executor-dsh-codex.js";
import type { AppServerSubprocess, AppServerSubprocessHandle } from "./macos-seatbelt-app-server.js";

/**
 * Structural seam shared by the real macOS Seatbelt boundary and the test
 * harness. Its `spawn` method remains the only place that may validate the
 * exact official Codex wrapper and construct the sandbox profile.
 */
export interface MacosSeatbeltAppServerClientBoundary extends AppServerExecutionBoundary, AppServerSubprocess {
  readonly id: string;
}

export interface MacosSeatbeltAppServerClientLaunchOptions {
  readonly boundary: MacosSeatbeltAppServerClientBoundary;
  /** Trusted package-local `@openai/codex/bin/codex.js` path. */
  readonly wrapper: string;
  readonly graceMs?: number;
}

/**
 * Turns an already-audited Seatbelt boundary into the direct App Server
 * client's launch seam. It never accepts a task-provided executable, cwd,
 * environment, or extra arguments.
 */
export class MacosSeatbeltAppServerClientLaunch implements CodexAppServerClientLaunch {
  readonly id: string;
  private readonly wrapper: string;
  private readonly graceMs: number;

  constructor(private readonly options: MacosSeatbeltAppServerClientLaunchOptions) {
    if (!path.isAbsolute(options.wrapper) || options.wrapper.includes("\0")) throw new DevkitError("APP_SERVER_BOUNDARY_REQUEST_REJECTED");
    if (options.graceMs !== undefined && (!Number.isSafeInteger(options.graceMs) || options.graceMs < 1000 || options.graceMs > 30000)) throw new DevkitError("APP_SERVER_BOUNDARY_REQUEST_REJECTED");
    this.wrapper = options.wrapper;
    this.graceMs = options.graceMs ?? 3000;
    this.id = `${options.boundary.id}:direct-client`;
  }

  async prepare(workspace: string, signal: AbortSignal): Promise<PreparedCodexAppServerClient> {
    const prepared = await this.options.boundary.prepare(workspace, signal);
    let child: AppServerSubprocessHandle;
    try {
      signal.throwIfAborted();
      child = this.options.boundary.spawn({
        argv: [process.execPath, this.wrapper, "app-server", "--stdio"],
        cwd: workspace,
        env: {},
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        graceMs: this.graceMs,
      });
    } catch (error) {
      let released = false;
      try { released = await prepared.release(true); } catch { /* preserve the startup failure below */ }
      if (!released) throw new DevkitError("CODEX_APP_SERVER_BOUNDARY_RELEASE_UNCONFIRMED");
      throw error;
    }
    return { child, release: stopped => prepared.release(stopped) };
  }
}

export function createMacosSeatbeltAppServerClientLaunch(options: MacosSeatbeltAppServerClientLaunchOptions): MacosSeatbeltAppServerClientLaunch {
  return new MacosSeatbeltAppServerClientLaunch(options);
}

import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevkitError } from "../contracts/task.js";
import type { CodexManagedAuthLaunch, PreparedCodexManagedAuthServer } from "./codex-managed-auth.js";
import {
  appServerEnvironment,
  appServerReadProfileInputs,
  isOfficialAppServerArgv,
  type AppServerSubprocess,
  type AppServerSubprocessHandle,
} from "./macos-seatbelt-app-server.js";
import { probeMacosSeatbelt, seatbeltReadRestrictedProfile, type SeatbeltCapability } from "./macos-seatbelt.js";
import type { PrivateCodexStateRoot } from "./private-codex-state.js";

const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface MacosSeatbeltManagedAuthLaunchOptions {
  /** Host-owned DSH subprocess service; no task or candidate service is accepted. */
  readonly subprocess: AppServerSubprocess;
  /** Trusted package-local `@openai/codex/bin/codex.js` path. */
  readonly wrapper: string;
  /** Persistent, non-overlapping host-owned `$CODEX_HOME`. */
  readonly state: PrivateCodexStateRoot;
  /** Existing control/candidate roots that remain final read denials. */
  readonly deniedReadRoots: readonly string[];
  readonly sandboxExec?: string;
  readonly graceMs?: number;
  /** Test seam; production uses the functional host probe. */
  readonly status?: () => Promise<SeatbeltCapability>;
}

function directory(value: string, code: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new DevkitError(code);
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) throw new DevkitError(code);
    return resolved;
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError(code);
  }
}

function directories(values: readonly string[], code: string): readonly string[] {
  const result = [...new Set(values.map(value => directory(value, code)))]
  if (!result.length) throw new DevkitError(code);
  return result;
}

/**
 * Dedicated macOS launch for the private managed-auth protocol. It has no
 * candidate cwd and always denies network, so it can safely establish the
 * persistent-state/filesystem contract but cannot yet run OAuth or a model.
 */
export class MacosSeatbeltManagedAuthLaunch implements CodexManagedAuthLaunch {
  readonly purpose = "private-managed-chatgpt-oauth" as const;
  readonly id: string;
  private readonly wrapper: string;
  private readonly sandboxExec: string;
  private readonly graceMs: number;
  private readonly deniedReadRoots: readonly string[];
  private readonly checkStatus: () => Promise<SeatbeltCapability>;
  private capability: Promise<SeatbeltCapability> | undefined;
  private active = false;

  constructor(private readonly options: MacosSeatbeltManagedAuthLaunchOptions) {
    if (!path.isAbsolute(options.wrapper) || options.wrapper.includes("\0")) throw new DevkitError("INVALID_MANAGED_AUTH_LAUNCH");
    if (options.graceMs !== undefined && (!Number.isSafeInteger(options.graceMs) || options.graceMs < 1000 || options.graceMs > 30000)) {
      throw new DevkitError("INVALID_MANAGED_AUTH_LAUNCH");
    }
    this.wrapper = options.wrapper;
    this.sandboxExec = options.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
    this.graceMs = options.graceMs ?? 3000;
    this.deniedReadRoots = directories(options.deniedReadRoots, "INVALID_MANAGED_AUTH_DENIED_ROOT");
    this.checkStatus = options.status ?? (() => probeMacosSeatbelt(this.sandboxExec));
    this.id = `${options.state.id}:macos-seatbelt-managed-auth-v1`;
  }

  status(): Promise<SeatbeltCapability> {
    this.capability ??= this.checkStatus();
    return this.capability;
  }

  async prepare(signal: AbortSignal): Promise<PreparedCodexManagedAuthServer> {
    if (this.active) throw new DevkitError("MANAGED_AUTH_LAUNCH_ALREADY_ACTIVE");
    signal.throwIfAborted();
    const capability = await this.status();
    signal.throwIfAborted();
    if (capability.state !== "supported") throw new DevkitError("SANDBOX_UNAVAILABLE", capability.reason);
    const argv = [process.execPath, this.wrapper, "app-server", "--stdio"] as const;
    if (!isOfficialAppServerArgv(argv)) throw new DevkitError("INVALID_MANAGED_AUTH_LAUNCH");
    const temporary = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-managed-auth-"));
    this.active = true;
    let child: AppServerSubprocessHandle;
    let rangeExited = false;
    let released = false;
    try {
      signal.throwIfAborted();
      const profile = seatbeltReadRestrictedProfile({
        writableRoots: [this.options.state.path, temporary],
        deniedReadRoots: this.deniedReadRoots,
        ...appServerReadProfileInputs(this.options.state.path, temporary, argv),
      });
      child = this.options.subprocess.spawn({
        argv: [this.sandboxExec, "-p", profile, "--", ...argv],
        cwd: this.options.state.path,
        env: appServerEnvironment(temporary, this.options.state.path),
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        graceMs: this.graceMs,
        signal,
      });
    } catch (error) {
      this.active = false;
      rmSync(temporary, { recursive: true, force: true, maxRetries: 1 });
      throw error;
    }
    return {
      child: {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        control: child.control,
        collected: child.collected,
        done: child.done,
        terminate: () => child.terminate(),
        waitForExit: async waitSignal => {
          const stopped = await child.waitForExit(waitSignal);
          if (stopped) rangeExited = true;
          return stopped;
        },
      },
      release: async stopped => {
        if (released) return true;
        if (!stopped || !rangeExited) return false;
        released = true;
        this.active = false;
        rmSync(temporary, { recursive: true, force: true, maxRetries: 1 });
        return true;
      },
    };
  }
}

export function createMacosSeatbeltManagedAuthLaunch(options: MacosSeatbeltManagedAuthLaunchOptions): MacosSeatbeltManagedAuthLaunch {
  return new MacosSeatbeltManagedAuthLaunch(options);
}

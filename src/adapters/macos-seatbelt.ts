import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DevkitError } from "../contracts/task.js";
import { redact } from "../domain/security.js";
import type { CommandConfinement, PreparedCommandConfinement } from "./process.js";

const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;

export interface SeatbeltProfilePolicy {
  /** Existing directories that the confined process may modify. */
  readonly writableRoots: readonly string[];
  /** Existing directories that the confined process must not read. */
  readonly deniedReadRoots: readonly string[];
}

export interface SeatbeltProbeFacts {
  readonly workspaceWriteAllowed: boolean;
  readonly controlWriteDenied: boolean;
  readonly protectedReadDenied: boolean;
  readonly networkDenied: boolean;
}

export type SeatbeltCapability =
  | {
    readonly state: "supported";
    readonly mechanism: "macos-seatbelt";
    readonly platform: "darwin";
    readonly enforcement: "full";
    readonly filesystem: "full";
    readonly network: "full";
    /** Only explicitly configured protected roots are covered; no broker exists yet. */
    readonly credentialReads: "configured-roots";
    readonly probe: SeatbeltProbeFacts;
  }
  | {
    readonly state: "unsupported";
    readonly mechanism: "macos-seatbelt";
    readonly platform: NodeJS.Platform;
    readonly enforcement: "none";
    readonly filesystem: "none";
    readonly network: "none";
    readonly credentialReads: "none";
    readonly reason: string;
  };

export interface PreparedSeatbeltCommand extends PreparedCommandConfinement {
  readonly environment: NodeJS.ProcessEnv;
  readonly temporaryRoot: string;
  readonly capability: Extract<SeatbeltCapability, { state: "supported" }>;
  /** Remove only the per-command directory created by this adapter. */
  dispose(): void;
}

function sbplString(value: string): string {
  return `"${value.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`)}"`;
}

function realDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new DevkitError("INVALID_SANDBOX_ROOT", label);
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) throw new DevkitError("INVALID_SANDBOX_ROOT", label);
    return resolved;
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError("INVALID_SANDBOX_ROOT", label);
  }
}

function uniqueDirectories(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => realDirectory(value, label)))];
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

/**
 * Produce a restrictive Seatbelt profile. It inherits the host's ordinary
 * read/execute behavior, but only the named roots are writable, configured
 * protected roots are unreadable, and every network operation is denied.
 */
export function seatbeltProfile(policy: SeatbeltProfilePolicy): string {
  const writableRoots = uniqueDirectories(policy.writableRoots, "writableRoots");
  const deniedReadRoots = uniqueDirectories(policy.deniedReadRoots, "deniedReadRoots");
  if (!writableRoots.length) throw new DevkitError("INVALID_SANDBOX_ROOT", "writableRoots");
  for (const protectedRoot of deniedReadRoots) {
    if (writableRoots.some((writableRoot) => overlaps(protectedRoot, writableRoot))) throw new DevkitError("SANDBOX_ROOTS_OVERLAP", protectedRoot);
  }
  const writable = [
    `(literal ${sbplString("/dev/null")})`,
    ...writableRoots.map((root) => `(subpath ${sbplString(root)})`),
  ].join(" ");
  return [
    "(version 1)",
    "(allow default)",
    ...deniedReadRoots.map((root) => `(deny file-read* (subpath ${sbplString(root)}))`),
    "(deny file-write*)",
    `(allow file-write* ${writable})`,
    "(deny network*)",
  ].join(" ");
}

function safeDetail(value: string): string {
  const clean = redact(value.replace(/\s+/g, " ").trim());
  return clean.length <= 600 ? clean : `${clean.slice(0, 600)}…`;
}

function terminate(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

interface SpawnedProbe {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

function runProbe(argv: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<SpawnedProbe> {
  return new Promise((resolve) => {
    const command = argv[0];
    if (command === undefined) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "empty probe argv" });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv.slice(1), {
        cwd,
        env: environment,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, ...(spawnError === undefined ? {} : { spawnError }) });
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (stdout.length + stderr.length + chunk.length > OUTPUT_LIMIT) {
        timedOut = true;
        try { terminate(child); } catch { /* settled close event reports the failure */ }
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => { spawnError = String(error); finish(null); });
    timer = setTimeout(() => {
      timedOut = true;
      try { terminate(child); } catch { /* settled close event reports the failure */ }
    }, PROBE_TIMEOUT_MS);
    child.on("close", (exitCode) => finish(exitCode));
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const CHILD_PROBE = String.raw`
  import fs from "node:fs";
  import net from "node:net";
  import path from "node:path";
  const result = {};
  try {
    fs.writeFileSync(path.join(process.env.DEVKIT_SEATBELT_WORKSPACE, "allowed.txt"), "ok");
    result.workspaceWriteAllowed = true;
  } catch {
    result.workspaceWriteAllowed = false;
  }
  try {
    fs.writeFileSync(path.join(process.env.DEVKIT_SEATBELT_CONTROL, "forbidden.txt"), "forbidden");
    result.controlWriteDenied = false;
  } catch {
    result.controlWriteDenied = true;
  }
  try {
    fs.readFileSync(path.join(process.env.DEVKIT_SEATBELT_SECRET, "credential.txt"), "utf8");
    result.protectedReadDenied = false;
  } catch {
    result.protectedReadDenied = true;
  }
  result.networkDenied = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.env.DEVKIT_SEATBELT_PORT) });
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.on("error", () => { clearTimeout(timer); resolve(true); });
  });
  console.log(JSON.stringify(result));
`;

function parseProbe(stdout: string): SeatbeltProbeFacts | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const result = value as Record<string, unknown>;
    const names = ["workspaceWriteAllowed", "controlWriteDenied", "protectedReadDenied", "networkDenied"] as const;
    if (names.some((name) => typeof result[name] !== "boolean")) return undefined;
    return {
      workspaceWriteAllowed: result.workspaceWriteAllowed as boolean,
      controlWriteDenied: result.controlWriteDenied as boolean,
      protectedReadDenied: result.protectedReadDenied as boolean,
      networkDenied: result.networkDenied as boolean,
    };
  } catch {
    return undefined;
  }
}

async function listenLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) throw new Error("seatbelt probe did not receive a loopback port");
  return address.port;
}

/**
 * Test the actual runner and the three boundaries required for untrusted code:
 * a permitted workspace write, denied control/credential reads, and no network.
 * It has no model, external endpoint, or user credential dependency.
 */
export async function probeMacosSeatbelt(sandboxExec = DEFAULT_SANDBOX_EXEC): Promise<SeatbeltCapability> {
  if (process.platform !== "darwin") {
    return {
      state: "unsupported", mechanism: "macos-seatbelt", platform: process.platform,
      enforcement: "none", filesystem: "none", network: "none", credentialReads: "none",
      reason: "MACOS_SEATBELT_REQUIRES_DARWIN",
    };
  }
  try {
    accessSync(sandboxExec, constants.X_OK);
  } catch {
    return {
      state: "unsupported", mechanism: "macos-seatbelt", platform: "darwin",
      enforcement: "none", filesystem: "none", network: "none", credentialReads: "none",
      reason: "SANDBOX_EXEC_UNAVAILABLE",
    };
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-probe-"));
  const workspace = path.join(root, "workspace");
  const control = path.join(root, "control");
  const secret = path.join(root, "secret");
  const temporary = path.join(root, "temporary");
  const server = createServer();
  let connections = 0;
  server.on("connection", (socket) => { connections += 1; socket.destroy(); });
  try {
    for (const directory of [workspace, control, secret, temporary]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(secret, "credential.txt"), "seatbelt-probe-secret", { mode: 0o600 });
    const port = await listenLoopback(server);
    const profile = seatbeltProfile({ writableRoots: [workspace, temporary], deniedReadRoots: [secret] });
    const environment: NodeJS.ProcessEnv = {
      HOME: workspace,
      USERPROFILE: workspace,
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      DEVKIT_SEATBELT_WORKSPACE: workspace,
      DEVKIT_SEATBELT_CONTROL: control,
      DEVKIT_SEATBELT_SECRET: secret,
      DEVKIT_SEATBELT_PORT: String(port),
    };
    const result = await runProbe([sandboxExec, "-p", profile, "--", process.execPath, "--input-type=module", "-e", CHILD_PROBE], workspace, environment);
    const facts = result.exitCode === 0 && !result.timedOut && result.spawnError === undefined ? parseProbe(result.stdout) : undefined;
    const controlUnchanged = !existsSync(path.join(control, "forbidden.txt"));
    if (facts && facts.workspaceWriteAllowed && facts.controlWriteDenied && facts.protectedReadDenied && facts.networkDenied && controlUnchanged && connections === 0) {
      return {
        state: "supported", mechanism: "macos-seatbelt", platform: "darwin",
        enforcement: "full", filesystem: "full", network: "full", credentialReads: "configured-roots", probe: facts,
      };
    }
    const detail = safeDetail([
      result.spawnError,
      result.timedOut ? "probe timed out" : undefined,
      result.stderr,
      result.stdout,
      `exit=${String(result.exitCode)}`,
      `connections=${connections}`,
    ].filter((value): value is string => Boolean(value)).join(" | "));
    return {
      state: "unsupported", mechanism: "macos-seatbelt", platform: "darwin",
      enforcement: "none", filesystem: "none", network: "none", credentialReads: "none",
      reason: `SEATBELT_PROBE_FAILED${detail ? `: ${detail}` : ""}`,
    };
  } catch (error) {
    return {
      state: "unsupported", mechanism: "macos-seatbelt", platform: "darwin",
      enforcement: "none", filesystem: "none", network: "none", credentialReads: "none",
      reason: `SEATBELT_PROBE_ERROR: ${safeDetail(String(error))}`,
    };
  } finally {
    await closeServer(server).catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
  }
}

/**
 * Wrap a trusted command plan in a verified Seatbelt profile. It intentionally
 * has no unconfined fallback. Credential protection is limited to the roots
 * explicitly supplied by the trusted host; a credential broker remains a
 * separate production gate.
 */
export class MacosSeatbeltCommandConfinement implements CommandConfinement {
  readonly id = "macos-seatbelt-v1";
  private capability?: Promise<SeatbeltCapability>;
  private readonly deniedReadRoots: readonly string[];

  constructor(options: { readonly deniedReadRoots: readonly string[]; readonly sandboxExec?: string }) {
    this.deniedReadRoots = uniqueDirectories(options.deniedReadRoots, "deniedReadRoots");
    this.sandboxExec = options.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
  }

  private readonly sandboxExec: string;

  status(): Promise<SeatbeltCapability> {
    this.capability ??= probeMacosSeatbelt(this.sandboxExec);
    return this.capability;
  }

  async prepare(argv: readonly string[], workspace: string, signal: AbortSignal): Promise<PreparedSeatbeltCommand> {
    if (!argv.length || argv.some((entry) => !entry || entry.includes("\0"))) throw new DevkitError("INVALID_COMMAND_PLAN");
    signal.throwIfAborted();
    const capability = await this.status();
    signal.throwIfAborted();
    if (capability.state !== "supported") throw new DevkitError("SANDBOX_UNAVAILABLE", capability.reason);
    const root = realDirectory(workspace, "workspace");
    const temporary = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-command-"));
    try {
      const profile = seatbeltProfile({ writableRoots: [root, temporary], deniedReadRoots: this.deniedReadRoots });
      return {
        argv: [this.sandboxExec, "-p", profile, "--", ...argv],
        environment: { HOME: root, USERPROFILE: root, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
        temporaryRoot: temporary,
        capability,
        dispose: () => rmSync(temporary, { recursive: true, force: true, maxRetries: 1 }),
      };
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 1 });
      throw error;
    }
  }
}

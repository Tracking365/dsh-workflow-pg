import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevkitError } from "../contracts/task.js";
import type { AppServerExecutionBoundary, PreparedAppServerExecution } from "./executor-dsh-codex.js";
import { probeMacosSeatbelt, seatbeltReadRestrictedProfile, type SeatbeltCapability } from "./macos-seatbelt.js";

const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// The confined App Server is a non-interactive process. Do not inherit a
// login shell's user-controlled search path, where a wrapper can turn a
// harmless tool lookup into host-code execution before Seatbelt sees it.
const SYSTEM_COMMAND_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// `dsh-subprocess-local` can add this proxy overlay after copying process.env,
// including names that were absent from `process.env` itself. Keep explicit
// tombstones for that separately-owned overlay as well.
const DSH_PROXY_ENVIRONMENT_NAMES = [
  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
  "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY", "NODE_USE_ENV_PROXY",
] as const;

/** Structural subset of DSH's synchronous subprocess seam. */
export interface AppServerSubprocessSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdio: { readonly stdin: "pipe"; readonly stdout: "pipe"; readonly stderr: "pipe"; readonly control?: "pipe" };
  readonly graceMs: number;
  readonly signal?: AbortSignal;
  /** The official provider must supply an explicit empty object. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Structural subset of a DSH-managed child handle. */
export interface AppServerSubprocessHandle {
  readonly stdin: NodeJS.WritableStream | undefined;
  readonly stdout: NodeJS.ReadableStream | undefined;
  readonly stderr: NodeJS.ReadableStream | undefined;
  readonly control: unknown;
  readonly collected: unknown;
  readonly done: Promise<unknown>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}

export interface AppServerSubprocess {
  spawn(spec: AppServerSubprocessSpec): AppServerSubprocessHandle;
}

export interface MacosSeatbeltAppServerConfinementOptions {
  /** The real DSH subprocess service, isolated before mounting the provider. */
  readonly subprocess: AppServerSubprocess;
  /** Existing host-owned roots that must be unreadable to the App Server. */
  readonly deniedReadRoots: readonly string[];
  readonly sandboxExec?: string;
  /** Test seam; production uses the functional host probe. */
  readonly status?: () => Promise<SeatbeltCapability>;
}

interface ActiveBoundary {
  readonly workspace: string;
  readonly temporary: string;
  attemptedSpawn: boolean;
  rangeExited: boolean;
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

function uniqueDirectories(values: readonly string[], label: string): readonly string[] {
  return [...new Set(values.map((value) => realDirectory(value, label)))];
}

function optionalDirectory(value: string, label: string): string | undefined {
  try {
    return realDirectory(value, label);
  } catch {
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Node resolves a main module by lstat-ing its absolute-path ancestors. Grant
 * metadata only for the exact ancestor chain under an otherwise denied
 * ambient root; directory data remains unavailable outside full read roots.
 */
function allowedAncestorMetadataRoots(allowedReadRoots: readonly string[], ambientDeniedReadRoots: readonly string[]): readonly string[] {
  const ancestors = new Set<string>();
  for (const allowedRoot of allowedReadRoots) {
    let current = path.dirname(allowedRoot);
    while (current !== path.dirname(current)) {
      if (ambientDeniedReadRoots.some((ambientRoot) => isWithin(ambientRoot, current))) ancestors.add(current);
      current = path.dirname(current);
    }
  }
  return [...ancestors];
}

/** The canonical module root rejects an arbitrary file merely named codex.js. */
function officialNodeModulesRoot(wrapper: string): string | undefined {
  try {
    const resolved = realpathSync(wrapper);
    if (!statSync(resolved).isFile() || path.basename(resolved) !== "codex.js") return undefined;
    const bin = path.dirname(resolved);
    const packageRoot = path.dirname(bin);
    const scopeRoot = path.dirname(packageRoot);
    const nodeModules = path.dirname(scopeRoot);
    if (path.basename(bin) !== "bin" || path.basename(packageRoot) !== "codex" || path.basename(scopeRoot) !== "@openai" || path.basename(nodeModules) !== "node_modules") return undefined;
    return realDirectory(nodeModules, "appServer.nodeModules");
  } catch {
    return undefined;
  }
}

/**
 * Block the primary ambient data locations before narrowly restoring the
 * candidate, private state, current Node executable directory and the exact
 * installed package tree that contains the official wrapper.  This is not a
 * universal macOS read allowlist; it specifically prevents home/cache/volume
 * discovery through the App Server process.
 */
/** Shared only by host-owned App Server launchers after exact argv validation. */
export function appServerReadProfileInputs(workspace: string, temporary: string, argv: readonly string[]): {
  readonly ambientDeniedReadRoots: readonly string[];
  readonly allowedReadRoots: readonly string[];
  readonly allowedReadMetadataRoots: readonly string[];
} {
  const wrapper = argv[1];
  const nodeModules = typeof wrapper === "string" ? officialNodeModulesRoot(wrapper) : undefined;
  if (nodeModules === undefined) throw new DevkitError("APP_SERVER_BOUNDARY_REQUEST_REJECTED");
  const nodeRuntime = realDirectory(path.dirname(realpathSync(process.execPath)), "appServer.nodeRuntime");
  const ambient = [
    os.homedir(),
    path.dirname(os.tmpdir()),
    "/tmp",
    "/private/tmp",
    "/Volumes",
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.CODEX_HOME,
  ].filter((root): root is string => typeof root === "string").map((root) => optionalDirectory(root, "ambientDeniedReadRoots")).filter((root): root is string => root !== undefined);
  const ambientDeniedReadRoots = [...new Set(ambient)];
  const allowedReadRoots = uniqueDirectories([workspace, temporary, nodeRuntime, nodeModules], "appServer.allowedReadRoots");
  return {
    ambientDeniedReadRoots,
    allowedReadRoots,
    allowedReadMetadataRoots: allowedAncestorMetadataRoots(allowedReadRoots, ambientDeniedReadRoots),
  };
}

function isExplicitEmptyEnvironment(value: NodeJS.ProcessEnv | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.keys(value).length === 0;
  } catch {
    return false;
  }
}

/**
 * The official provider has no public generic command surface. Keep the
 * narrow `node <package-local-codex-wrapper> app-server --stdio` shape at the
 * boundary so an arbitrary child cannot borrow the App Server capability.
 */
/** Reject any wrapper other than the package-local official App Server shape. */
export function isOfficialAppServerArgv(argv: readonly string[]): boolean {
  const wrapper = argv[1];
  if (argv.length !== 4 || argv[0] !== process.execPath || argv[2] !== "app-server" || argv[3] !== "--stdio" || typeof wrapper !== "string") return false;
  if (!path.isAbsolute(wrapper) || wrapper.includes("\0")) return false;
  return officialNodeModulesRoot(wrapper) !== undefined;
}

/**
 * Credential-scrubbed environment for one host-owned App Server. `codexHome`
 * is used only by a dedicated auth launcher; candidate launches leave it
 * absent so their state remains ephemeral beneath the private HOME.
 */
export function appServerEnvironment(temporary: string, codexHome?: string): NodeJS.ProcessEnv {
  if (codexHome !== undefined && (!path.isAbsolute(codexHome) || codexHome.includes("\0"))) throw new DevkitError("APP_SERVER_BOUNDARY_REQUEST_REJECTED");
  const config = path.join(temporary, "config");
  const cache = path.join(temporary, "cache");
  const data = path.join(temporary, "data");
  for (const directory of [config, cache, data]) mkdirSync(directory, { mode: 0o700 });
  // `dsh-subprocess-local` deliberately starts with a credential-scrubbed
  // parent environment, then applies this object. Explicit `undefined`
  // entries are documented tombstones there. Tombstone every ambient name,
  // rather than trying to maintain a partial deny-list of Node loaders,
  // dynamic-linker switches, shell startup hooks, proxy settings, and future
  // credential/config variables.
  const noAmbientEnvironment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(process.env)) noAmbientEnvironment[name] = undefined;
  for (const name of DSH_PROXY_ENVIRONMENT_NAMES) noAmbientEnvironment[name] = undefined;
  return {
    ...noAmbientEnvironment,
    // Keep only deterministic non-secret process basics. The provider starts
    // Node with an absolute path; candidate tools can use standard macOS
    // utilities but not a user-controlled login-shell PATH.
    PATH: SYSTEM_COMMAND_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: temporary,
    USERPROFILE: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }),
    // Avoid host Git configuration and interactive credential prompts when a
    // model asks a candidate-scoped command to inspect repository state.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * A host-owned bridge for the official provider's synchronous child-process
 * seam. `prepare()` performs its async functional Seatbelt check before a
 * candidate-bound provider request. `spawn()` then accepts exactly one
 * prepared official App Server launch and has no unconfined fallback.
 *
 * It is deliberately not a credential broker: it uses a fresh home, strips
 * known proxy/config pointers and denies every network operation. A real
 * model connection therefore remains blocked until a separately designed,
 * independently reviewable broker exists.
 */
export class MacosSeatbeltAppServerConfinement implements AppServerExecutionBoundary, AppServerSubprocess {
  readonly id = "macos-seatbelt-app-server-v1";
  private readonly deniedReadRoots: readonly string[];
  private readonly sandboxExec: string;
  private readonly checkStatus: () => Promise<SeatbeltCapability>;
  private capability?: Promise<SeatbeltCapability>;
  private readonly active = new Map<string, ActiveBoundary>();

  constructor(private readonly options: MacosSeatbeltAppServerConfinementOptions) {
    this.deniedReadRoots = uniqueDirectories(options.deniedReadRoots, "deniedReadRoots");
    if (!this.deniedReadRoots.length) throw new DevkitError("INVALID_SANDBOX_ROOT", "deniedReadRoots");
    this.sandboxExec = options.sandboxExec ?? DEFAULT_SANDBOX_EXEC;
    this.checkStatus = options.status ?? (() => probeMacosSeatbelt(this.sandboxExec));
  }

  status(): Promise<SeatbeltCapability> {
    this.capability ??= this.checkStatus();
    return this.capability;
  }

  async prepare(workspace: string, signal: AbortSignal): Promise<PreparedAppServerExecution> {
    signal.throwIfAborted();
    const capability = await this.status();
    signal.throwIfAborted();
    if (capability.state !== "supported") throw new DevkitError("SANDBOX_UNAVAILABLE", capability.reason);
    const root = realDirectory(workspace, "workspace");
    if (this.active.has(root)) throw new DevkitError("APP_SERVER_BOUNDARY_ALREADY_ACTIVE");
    const temporary = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-app-server-"));
    try {
      const active: ActiveBoundary = { workspace: root, temporary, attemptedSpawn: false, rangeExited: false };
      this.active.set(root, active);
      let released = false;
      return {
        release: async (stopped) => {
          if (released) return true;
          if (this.active.get(root) !== active) return false;
          // No returned child means synchronous spawn failed before a managed
          // range existed. Otherwise require the provider's own range proof.
          if (active.attemptedSpawn && !active.rangeExited) return false;
          if (!stopped && active.attemptedSpawn) return false;
          this.active.delete(root);
          released = true;
          rmSync(active.temporary, { recursive: true, force: true, maxRetries: 1 });
          return true;
        },
      };
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 1 });
      throw error;
    }
  }

  spawn(spec: AppServerSubprocessSpec): AppServerSubprocessHandle {
    const workspace = realDirectory(spec.cwd, "appServer.cwd");
    const active = this.active.get(workspace);
    if (!active) throw new DevkitError("APP_SERVER_BOUNDARY_NOT_PREPARED");
    if (active.attemptedSpawn) throw new DevkitError("APP_SERVER_BOUNDARY_ALREADY_SPAWNED");
    if (!isOfficialAppServerArgv(spec.argv) || !isExplicitEmptyEnvironment(spec.env) || spec.stdio.stdin !== "pipe" || spec.stdio.stdout !== "pipe" || spec.stdio.stderr !== "pipe") {
      throw new DevkitError("APP_SERVER_BOUNDARY_REQUEST_REJECTED");
    }
    active.attemptedSpawn = true;
    let child: AppServerSubprocessHandle;
    try {
      const profile = seatbeltReadRestrictedProfile({
        writableRoots: [active.workspace, active.temporary],
        deniedReadRoots: this.deniedReadRoots,
        ...appServerReadProfileInputs(active.workspace, active.temporary, spec.argv),
      });
      child = this.options.subprocess.spawn({
        ...spec,
        argv: [this.sandboxExec, "-p", profile, "--", ...spec.argv],
        env: appServerEnvironment(active.temporary),
      });
    } catch (error) {
      active.attemptedSpawn = false;
      throw error;
    }
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      control: child.control,
      collected: child.collected,
      done: child.done,
      terminate: () => child.terminate(),
      waitForExit: async (signal) => {
        const stopped = await child.waitForExit(signal);
        if (stopped) active.rangeExited = true;
        return stopped;
      },
    };
  }
}

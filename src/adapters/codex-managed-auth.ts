import { DevkitError } from "../contracts/task.js";
import {
  CodexAppServerDeferred,
  CodexAppServerJsonlConnection,
  CodexAppServerProtocolError,
  codexAppServerBoundedText,
  codexAppServerRecord,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
} from "./codex-app-server-jsonl.js";
import type { AppServerSubprocessHandle } from "./macos-seatbelt-app-server.js";

const CLIENT_INFO = { name: "dsh_devkit_auth", title: "DSH DevKit private auth", version: "0.1.0" } as const;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETAINED_LOGIN_RESULTS = 4;
const LOGIN_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type CodexManagedAuthLoginMethod = "browser" | "device-code";

/** Only the managed ChatGPT state is exposed; email and tokens never leave App Server. */
export type CodexManagedAuthStatus =
  | { readonly state: "authenticated" }
  | { readonly state: "unauthenticated" };

/**
 * Short-lived login material intended for a host-owned local presentation.
 * The URL and device code must never be stored in task records, artifacts,
 * logs, or a candidate workspace.
 */
export type CodexManagedAuthChallenge =
  | { readonly type: "browser"; readonly loginId: string; readonly authUrl: string }
  | { readonly type: "device-code"; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string };

export type CodexManagedAuthLoginCompletion =
  | { readonly state: "authenticated" }
  | { readonly state: "rejected" }
  | { readonly state: "cancelled" }
  | { readonly state: "timed-out" };

export interface PreparedCodexManagedAuthServer {
  /** A host-started App Server dedicated to private managed ChatGPT OAuth. */
  readonly child: AppServerSubprocessHandle;
  /** Release private launch state only after child quiescence is proven. */
  release(stopped: boolean): Promise<boolean> | boolean;
}

/**
 * This deliberately differs from the candidate-writer launch seam: it has no
 * workspace, cwd, task, argv, environment, or credential input. A concrete
 * implementation must own a private persistent Codex state root and must not
 * make its outbound transport or process usable by candidate code.
 */
export interface CodexManagedAuthLaunch {
  readonly id: string;
  readonly purpose: "private-managed-chatgpt-oauth";
  prepare(signal: AbortSignal): Promise<PreparedCodexManagedAuthServer>;
}

export interface CodexManagedAuthSessionOptions {
  readonly launch: CodexManagedAuthLaunch;
  readonly clientInfo?: { readonly name: string; readonly title: string; readonly version: string };
  /** Bounds a browser/device-code attempt retained by this in-memory session. */
  readonly loginTimeoutMs?: number;
}

interface PendingLogin {
  readonly completion: CodexAppServerDeferred<"completed" | "rejected" | "cancelled" | "timed-out">;
  readonly timer: NodeJS.Timeout;
  active: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return codexAppServerRecord(value);
}

function text(value: unknown, limit: number): string | undefined {
  return codexAppServerBoundedText(value, limit);
}

function loginId(value: unknown): string | undefined {
  const parsed = text(value, 200);
  return parsed !== undefined && LOGIN_ID.test(parsed) ? parsed : undefined;
}

function managedAuthUrl(value: unknown, kind: CodexManagedAuthLoginMethod): string | undefined {
  const raw = text(value, 4096);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    const host = url.hostname.toLowerCase();
    if (kind === "browser") {
      if (host !== "auth.openai.com" && host !== "chatgpt.com" && !host.endsWith(".chatgpt.com")) return undefined;
    } else if (host !== "auth.openai.com") {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function deviceCode(value: unknown): string | undefined {
  const parsed = text(value, 100);
  return parsed !== undefined && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,4}$/.test(parsed) ? parsed : undefined;
}

function loginTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_LOGIN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 30 * 60 * 1000) throw new DevkitError("INVALID_CODEX_MANAGED_AUTH_TIMEOUT");
  return timeout;
}

function asDevkitError(error: unknown, fallback: string): DevkitError {
  if (error instanceof DevkitError) return error;
  if (error instanceof CodexAppServerProtocolError) return new DevkitError(error.code);
  return new DevkitError(fallback);
}

async function releasePrepared(prepared: PreparedCodexManagedAuthServer): Promise<void> {
  try { prepared.child.terminate(); } catch { /* exit proof remains authoritative */ }
  let stopped = false;
  try { stopped = await prepared.child.waitForExit(); } catch { stopped = false; }
  let released = false;
  try { released = await prepared.release(stopped); } catch { released = false; }
  if (!stopped || !released) throw new DevkitError("CODEX_MANAGED_AUTH_RELEASE_UNCONFIRMED");
}

async function awaitAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DevkitError("CANCELLED");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DevkitError("CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      result => { signal.removeEventListener("abort", onAbort); resolve(result); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * Host-only App Server account client. Its public API deliberately contains
 * only `initialize`, `account/read`, managed ChatGPT login, and cancellation;
 * it cannot create threads, start turns, access a candidate workspace, inject
 * external tokens, or grant App Server approvals.
 */
export class CodexManagedAuthSession {
  private readonly connection: CodexAppServerJsonlConnection;
  private readonly clientInfo: { readonly name: string; readonly title: string; readonly version: string };
  private readonly loginTimeoutMs: number;
  private readonly logins = new Map<string, PendingLogin>();
  private readonly retainedLoginIds: string[] = [];
  private activeLoginId: string | undefined;
  private closed = false;
  private failure: DevkitError | undefined;

  private constructor(private readonly prepared: PreparedCodexManagedAuthServer, options: CodexManagedAuthSessionOptions) {
    this.clientInfo = options.clientInfo ?? CLIENT_INFO;
    this.loginTimeoutMs = loginTimeout(options.loginTimeoutMs);
    this.connection = new CodexAppServerJsonlConnection(prepared.child, {
      onServerRequest: async request => await this.rejectServerRequest(request),
      onNotification: notification => this.handleNotification(notification),
      onFailure: error => this.fail(new DevkitError(error.code)),
    });
  }

  static async open(options: CodexManagedAuthSessionOptions, signal: AbortSignal = new AbortController().signal): Promise<CodexManagedAuthSession> {
    if (options.launch.purpose !== "private-managed-chatgpt-oauth") throw new DevkitError("INVALID_CODEX_MANAGED_AUTH_LAUNCH");
    if (!text(options.launch.id, 200)) throw new DevkitError("INVALID_CODEX_MANAGED_AUTH_LAUNCH");
    if (signal.aborted) throw new DevkitError("CANCELLED");
    let prepared: PreparedCodexManagedAuthServer | undefined;
    let session: CodexManagedAuthSession | undefined;
    try {
      prepared = await options.launch.prepare(signal);
      if (signal.aborted) throw new DevkitError("CANCELLED");
      session = new CodexManagedAuthSession(prepared, options);
      const initialized = await awaitAbort(session.connection.request("initialize", {
        clientInfo: session.clientInfo,
        capabilities: { experimentalApi: false, requestAttestation: false },
      }), signal);
      if (record(initialized) === undefined) throw new DevkitError("CODEX_MANAGED_AUTH_INITIALIZE_INVALID");
      await awaitAbort(session.connection.notify("initialized", {}), signal);
      return session;
    } catch (error) {
      if (session !== undefined) {
        try {
          await session.close();
        } catch (cleanupError) {
          throw asDevkitError(cleanupError, "CODEX_MANAGED_AUTH_STARTUP_CLEANUP_FAILED");
        }
      } else if (prepared !== undefined) {
        try {
          await releasePrepared(prepared);
        } catch (cleanupError) {
          throw asDevkitError(cleanupError, "CODEX_MANAGED_AUTH_STARTUP_CLEANUP_FAILED");
        }
      }
      if (signal.aborted) throw new DevkitError("CANCELLED");
      throw asDevkitError(error, "CODEX_MANAGED_AUTH_START_FAILED");
    }
  }

  /** Reads and sanitizes only managed-ChatGPT account state; no token refresh is forced. */
  async status(signal: AbortSignal = new AbortController().signal): Promise<CodexManagedAuthStatus> {
    this.assertUsable();
    try {
      const result = record(await awaitAbort(this.connection.request("account/read", { refreshToken: false }), signal));
      if (result === undefined || result.requiresOpenaiAuth !== true || !Object.hasOwn(result, "account")) throw new DevkitError("CODEX_MANAGED_AUTH_ACCOUNT_INVALID");
      if (result.account === null) return Object.freeze({ state: "unauthenticated" } as const);
      const account = record(result.account);
      if (account?.type !== "chatgpt") throw new DevkitError("CODEX_MANAGED_AUTH_ACCOUNT_TYPE_REJECTED");
      return Object.freeze({ state: "authenticated" } as const);
    } catch (error) {
      if (signal.aborted) throw new DevkitError("CANCELLED");
      throw asDevkitError(error, "CODEX_MANAGED_AUTH_ACCOUNT_READ_FAILED");
    }
  }

  /** Starts only Codex-managed browser or device-code ChatGPT OAuth. */
  async beginLogin(method: CodexManagedAuthLoginMethod, signal: AbortSignal = new AbortController().signal): Promise<CodexManagedAuthChallenge> {
    this.assertUsable();
    if (this.activeLoginId !== undefined) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_IN_PROGRESS");
    if (await this.status(signal).then(value => value.state === "authenticated")) throw new DevkitError("CODEX_MANAGED_AUTH_ALREADY_AUTHENTICATED");
    try {
      const response = await awaitAbort(this.connection.request("account/login/start", method === "browser"
        ? { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" }
        : { type: "chatgptDeviceCode" }), signal);
      const challenge = this.parseChallenge(method, response);
      if (this.logins.has(challenge.loginId)) throw new DevkitError("CODEX_MANAGED_AUTH_DUPLICATE_LOGIN");
      const completion = new CodexAppServerDeferred<"completed" | "rejected" | "cancelled" | "timed-out">();
      const timer = setTimeout(() => { void this.expireLogin(challenge.loginId); }, this.loginTimeoutMs);
      this.logins.set(challenge.loginId, { completion, timer, active: true });
      this.activeLoginId = challenge.loginId;
      return Object.freeze(challenge);
    } catch (error) {
      if (signal.aborted) throw new DevkitError("CANCELLED");
      throw asDevkitError(error, "CODEX_MANAGED_AUTH_LOGIN_START_FAILED");
    }
  }

  /** Waits for one matching managed-login completion and verifies it with account/read. */
  async waitForLogin(login: string, signal: AbortSignal = new AbortController().signal): Promise<CodexManagedAuthLoginCompletion> {
    const entry = this.logins.get(login);
    if (entry === undefined) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_UNKNOWN");
    try {
      const outcome = await awaitAbort(entry.completion.promise, signal);
      this.logins.delete(login);
      const index = this.retainedLoginIds.indexOf(login);
      if (index >= 0) this.retainedLoginIds.splice(index, 1);
      if (outcome === "rejected" || outcome === "cancelled" || outcome === "timed-out") return Object.freeze({ state: outcome } as const);
      if ((await this.status(signal)).state !== "authenticated") throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_NOT_ESTABLISHED");
      return Object.freeze({ state: "authenticated" } as const);
    } catch (error) {
      if (signal.aborted) {
        try { await this.cancelLogin(login); } catch { /* session close remains authoritative */ }
        throw new DevkitError("CANCELLED");
      }
      throw asDevkitError(error, "CODEX_MANAGED_AUTH_LOGIN_WAIT_FAILED");
    }
  }

  /** Cancels only the active matching managed login; it never logs out a private account. */
  async cancelLogin(login: string): Promise<void> {
    const entry = this.logins.get(login);
    if (entry === undefined || !entry.active || this.activeLoginId !== login) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_UNKNOWN");
    this.assertUsable();
    try {
      await this.connection.request("account/login/cancel", { loginId: login });
      this.finishLogin(login, "cancelled");
    } catch (error) {
      throw asDevkitError(error, "CODEX_MANAGED_AUTH_LOGIN_CANCEL_FAILED");
    }
  }

  /** Terminates this dedicated App Server and requires both exit and release proof. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.activeLoginId;
    if (active !== undefined) {
      try { await this.connection.request("account/login/cancel", { loginId: active }); } catch { /* process teardown below is authoritative */ }
    }
    this.fail(new DevkitError("CODEX_MANAGED_AUTH_SESSION_CLOSED"));
    this.connection.dispose();
    await releasePrepared(this.prepared);
  }

  private assertUsable(): void {
    if (this.closed) throw new DevkitError("CODEX_MANAGED_AUTH_SESSION_CLOSED");
    if (this.failure !== undefined) throw this.failure;
  }

  private parseChallenge(method: CodexManagedAuthLoginMethod, response: unknown): CodexManagedAuthChallenge {
    const result = record(response);
    const id = result === undefined ? undefined : loginId(result.loginId);
    if (result === undefined || id === undefined) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_RESPONSE_INVALID");
    if (method === "browser") {
      const authUrl = managedAuthUrl(result.authUrl, method);
      if (result.type !== "chatgpt" || authUrl === undefined) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_RESPONSE_INVALID");
      return { type: "browser", loginId: id, authUrl };
    }
    const verificationUrl = managedAuthUrl(result.verificationUrl, method);
    const userCode = deviceCode(result.userCode);
    if (result.type !== "chatgptDeviceCode" || verificationUrl === undefined || userCode === undefined) throw new DevkitError("CODEX_MANAGED_AUTH_LOGIN_RESPONSE_INVALID");
    return { type: "device-code", loginId: id, verificationUrl, userCode };
  }

  private async rejectServerRequest(request: CodexAppServerRequest): Promise<void> {
    // This session is not an external-token host and has no task/tool/input
    // bridge. In particular, never respond to token-refresh or user-input
    // requests with host data.
    await this.connection.respondError(request.id, -32601, "Unsupported private managed-auth request");
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    if (notification.method !== "account/login/completed") return;
    const result = record(notification.params);
    const id = result === undefined ? undefined : loginId(result.loginId);
    if (result === undefined || id === undefined || id !== this.activeLoginId) return;
    if (typeof result.success !== "boolean") {
      this.fail(new DevkitError("CODEX_MANAGED_AUTH_LOGIN_COMPLETION_INVALID"));
      return;
    }
    this.finishLogin(id, result.success ? "completed" : "rejected");
  }

  private async expireLogin(login: string): Promise<void> {
    const entry = this.logins.get(login);
    if (entry === undefined || !entry.active || this.closed) return;
    this.finishLogin(login, "timed-out");
    try { await this.connection.request("account/login/cancel", { loginId: login }); } catch { /* close/release still handles process ownership */ }
  }

  private finishLogin(login: string, outcome: "completed" | "rejected" | "cancelled" | "timed-out"): void {
    const entry = this.logins.get(login);
    if (entry === undefined || !entry.active) return;
    entry.active = false;
    clearTimeout(entry.timer);
    if (this.activeLoginId === login) this.activeLoginId = undefined;
    this.retainedLoginIds.push(login);
    while (this.retainedLoginIds.length > MAX_RETAINED_LOGIN_RESULTS) {
      const expired = this.retainedLoginIds.shift();
      if (expired !== undefined && expired !== login) this.logins.delete(expired);
    }
    entry.completion.resolve(outcome);
  }

  private fail(error: DevkitError): void {
    if (this.failure === undefined) this.failure = error;
    for (const [login, entry] of this.logins) {
      clearTimeout(entry.timer);
      entry.active = false;
      entry.completion.reject(this.failure);
      this.logins.delete(login);
    }
    this.activeLoginId = undefined;
    this.retainedLoginIds.length = 0;
  }
}

export async function openCodexManagedAuthSession(options: CodexManagedAuthSessionOptions, signal?: AbortSignal): Promise<CodexManagedAuthSession> {
  return await CodexManagedAuthSession.open(options, signal);
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DevkitError } from "../contracts/task.js";
import { LocalRecoveryApprovalBroker, type PendingRecoveryApproval } from "./local-recovery-broker.js";

const MAX_FORM_BYTES = 8 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_RECOVERY_RUNS = 32;

interface Session { readonly csrf: string; readonly expiresAt: number }
interface RecoveryResult { readonly taskId: string; readonly status: string; readonly reason?: string }
interface RecoveryRun { readonly taskId: string; readonly state: "waiting-for-proof" | "requeued" | "failed"; readonly updatedAt: string; readonly reason?: string }

export interface LocalRecoveryControlPlaneOptions {
  readonly broker: LocalRecoveryApprovalBroker;
  /** Host-owned secret callback; its value is never rendered or logged. */
  readonly credential: () => string;
  /** Audited as the trusted local-control-plane identity after authentication. */
  readonly operatorId: string;
  /** Host-only action; it is never represented by a DSH task tool. */
  readonly recover: (taskId: string) => Promise<RecoveryResult>;
  readonly port?: number;
}

export interface LocalRecoveryControlPlaneInfo { readonly url: string }

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function formValue(form: URLSearchParams, key: string): string | undefined {
  const values = form.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const source = request.headers.cookie;
  if (source === undefined || source.length > 8192) return undefined;
  for (const part of source.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length === 1) return rest[0];
  }
  return undefined;
}

function sameSecret(a: string, b: string): boolean {
  const left = digest(a), right = digest(b);
  try { return timingSafeEqual(left, right); } finally { left.fill(0); right.fill(0); }
}

function matchesDigest(value: string, expected: Buffer): boolean {
  const actual = digest(value);
  try { return timingSafeEqual(actual, expected); } finally { actual.fill(0); }
}

function validOperatorId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value);
}

function validTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function safeReason(error: unknown): string {
  return error instanceof DevkitError ? error.code : "RECOVERY_CONTROL_PLANE_OPERATION_FAILED";
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_FORM_BYTES) return undefined;
    chunks.push(bytes);
  }
  try { return new URLSearchParams(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

/**
 * Loopback-only presentation for retained-run recovery. It can initiate only
 * host-side `recover(taskId)` calls; each call still waits for the separate
 * bound broker proof and Devkit's second durable-state inspection.
 */
export class LocalRecoveryControlPlane {
  private readonly port: number;
  private readonly operatorId: string;
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, RecoveryRun>();
  private readonly operations = new Map<string, Promise<void>>();
  private server: Server | undefined;
  private origin: string | undefined;
  private credentialHash: Buffer | undefined;
  private closed = false;

  constructor(private readonly options: LocalRecoveryControlPlaneOptions) {
    if (!Number.isSafeInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE_PORT");
    if (typeof options.operatorId !== "string" || !validOperatorId(options.operatorId)) throw new DevkitError("INVALID_RECOVERY_OPERATOR");
    if (typeof options.recover !== "function") throw new DevkitError("INVALID_RECOVERY_CONTROL_PLANE_ACTION");
    this.port = options.port ?? 0;
    this.operatorId = options.operatorId;
  }

  async start(): Promise<LocalRecoveryControlPlaneInfo> {
    if (this.origin !== undefined) return { url: this.origin };
    if (this.closed) throw new DevkitError("RECOVERY_CONTROL_PLANE_CLOSED");
    let credential: string;
    try { credential = this.options.credential(); } catch { throw new DevkitError("RECOVERY_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE"); }
    if (typeof credential !== "string" || credential.length < 32 || credential.length > 4096 || credential.includes("\0")) throw new DevkitError("RECOVERY_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE");
    this.credentialHash = digest(credential);
    credential = "";
    const server = createServer((request, response) => { void this.handle(request, response); });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, "127.0.0.1");
      });
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") throw new DevkitError("RECOVERY_CONTROL_PLANE_BIND_FAILED");
      this.server = server;
      this.origin = `http://127.0.0.1:${address.port}`;
      return { url: this.origin };
    } catch (error) {
      this.credentialHash.fill(0);
      this.credentialHash = undefined;
      try { server.close(); } catch { /* the listener was never made available */ }
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("RECOVERY_CONTROL_PLANE_BIND_FAILED");
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    this.sessions.clear();
    this.credentialHash?.fill(0);
    this.credentialHash = undefined;
    this.options.broker.close();
    if (server === undefined) return;
    try { server.closeAllConnections?.(); } catch { /* close below remains authoritative */ }
    await new Promise<void>(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.isSameOrigin(request) || (request.method === "POST" && request.headers.origin !== this.origin)) return this.writeText(response, 403, "Forbidden");
      const origin = this.origin;
      if (origin === undefined || this.closed) return this.writeText(response, 503, "Unavailable");
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) return this.writeText(response, 403, "Forbidden");
      if (request.method === "GET" && url.pathname === "/") return this.renderHome(request, response);
      if (request.method === "POST" && url.pathname === "/session") return await this.createSession(request, response);
      if (request.method === "POST" && url.pathname === "/recoveries") return await this.requestRecovery(request, response);
      if (request.method === "POST" && url.pathname.startsWith("/recoveries/")) return await this.resolveRecovery(request, response, url.pathname.slice("/recoveries/".length));
      return this.writeText(response, 404, "Not found");
    } catch {
      if (!response.headersSent) this.writeText(response, 500, "Internal error");
      else response.end();
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const origin = this.origin;
    const requested = request.headers.origin;
    return origin !== undefined && (requested === undefined || requested === origin);
  }

  private session(request: IncomingMessage): Session | undefined {
    this.pruneSessions();
    const id = cookieValue(request, "dsh_devkit_recovery_session");
    if (id === undefined) return undefined;
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  private renderHome(request: IncomingMessage, response: ServerResponse): void {
    const session = this.session(request);
    if (session === undefined) {
      this.writeHtml(response, 200, "<!doctype html><meta charset=utf-8><title>DSH DevKit recovery</title><h1>DSH DevKit recovery</h1><form method=post action=/session><label>Local recovery secret <input name=token type=password autocomplete=current-password required></label><button type=submit>Open recovery controls</button></form>");
      return;
    }
    const pending = this.options.broker.pending();
    const pendingCards = pending.length === 0 ? "<p>No pending recovery proofs.</p>" : pending.map(value => this.renderPending(value, session.csrf)).join("\n");
    const runs = [...this.runs.values()].sort((left, right) => right.updatedAt < left.updatedAt ? -1 : right.updatedAt > left.updatedAt ? 1 : 0);
    const runCards = runs.length === 0 ? "<p>No recent recovery requests.</p>" : runs.map(value => this.renderRun(value)).join("\n");
    this.writeHtml(response, 200, `<!doctype html><meta charset=utf-8><title>DSH DevKit recovery</title><h1>Interrupted-task recovery</h1><p>Recovery preserves the old workspace and can only queue a fresh clone after you verify the old writer stopped.</p><form method=post action=/recoveries><input type=hidden name=csrf value="${escapeHtml(session.csrf)}"><label>Task ID <input name=taskId autocomplete=off required></label><button type=submit>Request recovery</button></form><h2>Pending proofs</h2>${pendingCards}<h2>Recent requests</h2>${runCards}`);
  }

  private renderPending(pending: PendingRecoveryApproval, csrf: string): string {
    const request = pending.request;
    const action = `/recoveries/${encodeURIComponent(pending.approvalId)}`;
    const snapshots = [
      `Expected snapshot: ${request.expectedSnapshotId ?? "(none)"}`,
      `Observed snapshot: ${request.observedSnapshotId ?? "(none)"}`,
    ].join("\n");
    return `<article><h3>Task ${escapeHtml(request.taskId)}</h3><p>Retained run: ${escapeHtml(request.runId)}</p><p>Workspace state: ${escapeHtml(request.workspaceState)}</p><p>Policy current: ${escapeHtml(String(request.policyCurrent))}; base available: ${escapeHtml(String(request.baseAvailable))}</p><pre>${escapeHtml(snapshots)}</pre><p>Expires: ${escapeHtml(pending.expiresAt)}</p><form method=post action="${action}"><input type=hidden name=csrf value="${escapeHtml(csrf)}"><label><input type=checkbox name=oldWriterStopped value=yes required> I verified the old writer has stopped.</label><button name=decision value=accept type=submit>Queue fresh clone once</button><button name=decision value=decline type=submit>Keep retained lease</button></form></article>`;
  }

  private renderRun(run: RecoveryRun): string {
    const reason = run.reason === undefined ? "" : `<p>Reason: ${escapeHtml(run.reason)}</p>`;
    return `<article><h3>Task ${escapeHtml(run.taskId)}</h3><p>State: ${escapeHtml(run.state)}</p>${reason}<p>Updated: ${escapeHtml(run.updatedAt)}</p></article>`;
  }

  private async createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const token = form === undefined ? undefined : formValue(form, "token");
    const credentialHash = this.credentialHash;
    if (token === undefined || credentialHash === undefined || !matchesDigest(token, credentialHash)) return this.writeText(response, 403, "Forbidden");
    this.pruneSessions();
    if (this.sessions.size >= MAX_SESSIONS) return this.writeText(response, 429, "Too many active recovery sessions");
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader("Set-Cookie", `dsh_devkit_recovery_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private async requestRecovery(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.session(request);
    if (session === undefined) return this.writeText(response, 401, "Authentication required");
    const form = await readForm(request);
    const csrf = form === undefined ? undefined : formValue(form, "csrf");
    const taskId = form === undefined ? undefined : formValue(form, "taskId");
    if (csrf === undefined || !sameSecret(csrf, session.csrf) || taskId === undefined || !validTaskId(taskId)) return this.writeText(response, 403, "Forbidden");
    try { this.startRecovery(taskId); }
    catch (error) { return this.writeText(response, error instanceof DevkitError && error.code === "RECOVERY_CONTROL_PLANE_BUSY" ? 429 : 409, "Recovery is not available"); }
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private async resolveRecovery(request: IncomingMessage, response: ServerResponse, encodedId: string): Promise<void> {
    const session = this.session(request);
    if (session === undefined) return this.writeText(response, 401, "Authentication required");
    let approvalId: string;
    try { approvalId = decodeURIComponent(encodedId); } catch { return this.writeText(response, 400, "Invalid recovery request"); }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(approvalId)) return this.writeText(response, 400, "Invalid recovery request");
    const form = await readForm(request);
    const csrf = form === undefined ? undefined : formValue(form, "csrf");
    const decision = form === undefined ? undefined : formValue(form, "decision");
    const oldWriterStopped = form === undefined ? undefined : formValue(form, "oldWriterStopped");
    if (csrf === undefined || !sameSecret(csrf, session.csrf) || (decision !== "accept" && decision !== "decline") || (decision === "accept" && oldWriterStopped !== "yes")) return this.writeText(response, 403, "Forbidden");
    const pending = this.options.broker.pending().find(value => value.approvalId === approvalId);
    if (pending === undefined) return this.writeText(response, 409, "Recovery proof is no longer pending");
    const resolved = this.options.broker.resolve({
      approvalId,
      taskId: pending.request.taskId,
      runId: pending.request.runId,
      fingerprint: pending.request.fingerprint,
      decision,
      ...(decision === "accept" ? { oldWriterStopped: true } : {}),
      operatorId: this.operatorId,
    });
    if (resolved.state !== "accepted") return this.writeText(response, 409, "Recovery proof is no longer pending");
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private startRecovery(taskId: string): void {
    if (this.operations.has(taskId)) return;
    this.pruneRuns();
    if (!this.runs.has(taskId) && this.runs.size >= MAX_RECOVERY_RUNS) throw new DevkitError("RECOVERY_CONTROL_PLANE_BUSY");
    this.runs.set(taskId, { taskId, state: "waiting-for-proof", updatedAt: new Date().toISOString() });
    const operation = Promise.resolve()
      .then(async () => await this.options.recover(taskId))
      .then(result => this.setRun({ taskId, state: "requeued", updatedAt: new Date().toISOString(), ...(result.reason === undefined ? {} : { reason: result.reason }) }))
      .catch(error => this.setRun({ taskId, state: "failed", updatedAt: new Date().toISOString(), reason: safeReason(error) }));
    this.operations.set(taskId, operation);
    void operation.finally(() => {
      if (this.operations.get(taskId) === operation) this.operations.delete(taskId);
    });
  }

  private setRun(run: RecoveryRun): void {
    if (!this.closed) this.runs.set(run.taskId, run);
  }

  private pruneSessions(now = Date.now()): void {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }

  private pruneRuns(): void {
    while (this.runs.size >= MAX_RECOVERY_RUNS) {
      const terminal = [...this.runs.entries()].find(([, run]) => run.state !== "waiting-for-proof");
      if (terminal === undefined) break;
      this.runs.delete(terminal[0]);
    }
  }

  private headers(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }

  private writeHtml(response: ServerResponse, status: number, body: string): void {
    this.headers(response);
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  }

  private writeText(response: ServerResponse, status: number, body: string): void {
    this.headers(response);
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(body);
  }
}

export function createLocalRecoveryControlPlane(options: LocalRecoveryControlPlaneOptions): LocalRecoveryControlPlane {
  return new LocalRecoveryControlPlane(options);
}

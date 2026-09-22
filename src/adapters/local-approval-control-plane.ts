import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DevkitError } from "../contracts/task.js";
import { LocalCodexApprovalBroker, type PendingCodexApproval } from "./local-approval-broker.js";

const MAX_FORM_BYTES = 8 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 32;

interface Session { readonly csrf: string; readonly expiresAt: number }

export interface LocalApprovalControlPlaneOptions {
  readonly broker: LocalCodexApprovalBroker;
  /** Host-owned secret callback; its value is never rendered or logged. */
  readonly credential: () => string;
  /** Audited as the trusted local-control-plane identity after authentication. */
  readonly operatorId: string;
  readonly port?: number;
}

export interface LocalApprovalControlPlaneInfo { readonly url: string }

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
 * Loopback-only human presentation for LocalCodexApprovalBroker. The browser
 * must authenticate with a host-provided secret; no approval capability is
 * included in a DSH tool result, App Server prompt, task record, or URL.
 */
export class LocalApprovalControlPlane {
  private readonly port: number;
  private readonly operatorId: string;
  private readonly sessions = new Map<string, Session>();
  private server: Server | undefined;
  private origin: string | undefined;
  private credentialHash: Buffer | undefined;

  constructor(private readonly options: LocalApprovalControlPlaneOptions) {
    if (!Number.isSafeInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new DevkitError("INVALID_APPROVAL_CONTROL_PLANE_PORT");
    if (typeof options.operatorId !== "string" || !validOperatorId(options.operatorId)) throw new DevkitError("INVALID_APPROVAL_OPERATOR");
    this.port = options.port ?? 0;
    this.operatorId = options.operatorId;
  }

  async start(): Promise<LocalApprovalControlPlaneInfo> {
    if (this.origin !== undefined) return { url: this.origin };
    let credential: string;
    try { credential = this.options.credential(); } catch { throw new DevkitError("APPROVAL_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE"); }
    if (typeof credential !== "string" || credential.length < 32 || credential.length > 4096 || credential.includes("\0")) throw new DevkitError("APPROVAL_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE");
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
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") throw new DevkitError("APPROVAL_CONTROL_PLANE_BIND_FAILED");
      this.server = server;
      this.origin = `http://127.0.0.1:${address.port}`;
      return { url: this.origin };
    } catch (error) {
      this.credentialHash.fill(0);
      this.credentialHash = undefined;
      try { server.close(); } catch { /* the listener was never made available */ }
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("APPROVAL_CONTROL_PLANE_BIND_FAILED");
    }
  }

  async stop(): Promise<void> {
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
      if (origin === undefined) return this.writeText(response, 503, "Unavailable");
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) return this.writeText(response, 403, "Forbidden");
      if (request.method === "GET" && url.pathname === "/") return this.renderHome(request, response);
      if (request.method === "POST" && url.pathname === "/session") return await this.createSession(request, response);
      if (request.method === "POST" && url.pathname.startsWith("/approvals/")) return await this.resolveApproval(request, response, url.pathname.slice("/approvals/".length));
      return this.writeText(response, 404, "Not found");
    } catch {
      if (!response.headersSent) this.writeText(response, 500, "Internal error");
      else response.end();
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const origin = this.origin;
    if (origin === undefined) return false;
    const requested = request.headers.origin;
    return requested === undefined || requested === origin;
  }

  private session(request: IncomingMessage): Session | undefined {
    this.pruneSessions();
    const id = cookieValue(request, "dsh_devkit_approval_session");
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
      this.writeHtml(response, 200, "<!doctype html><meta charset=utf-8><title>DSH DevKit approval</title><h1>DSH DevKit approval</h1><form method=post action=/session><label>Local approval secret <input name=token type=password autocomplete=current-password required></label><button type=submit>Open approvals</button></form>");
      return;
    }
    const approvals = this.options.broker.pending();
    const cards = approvals.length === 0
      ? "<p>No pending approvals.</p>"
      : approvals.map(approval => this.renderApproval(approval, session.csrf)).join("\n");
    this.writeHtml(response, 200, `<!doctype html><meta charset=utf-8><title>DSH DevKit approvals</title><h1>Pending approvals</h1>${cards}`);
  }

  private renderApproval(approval: PendingCodexApproval, csrf: string): string {
    const request = approval.request;
    const detail = request.kind === "command"
      ? `<pre>${escapeHtml(request.command ?? "(command unavailable)")}</pre>`
      : `<pre>${escapeHtml((request.paths ?? []).join("\n") || "(paths unavailable)")}</pre>`;
    const reason = request.reason === undefined ? "" : `<p>Reason: ${escapeHtml(request.reason)}</p>`;
    const action = `/approvals/${encodeURIComponent(approval.approvalId)}`;
    return `<article><h2>${escapeHtml(request.kind)} · ${escapeHtml(request.taskId)}</h2><p>cwd: ${escapeHtml(request.cwd)}</p>${reason}${detail}<p>Expires: ${escapeHtml(approval.expiresAt)}</p><form method=post action="${action}"><input type=hidden name=csrf value="${escapeHtml(csrf)}"><button name=decision value=accept type=submit>Accept once</button><button name=decision value=decline type=submit>Decline</button></form></article>`;
  }

  private async createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const token = form === undefined ? undefined : formValue(form, "token");
    const credentialHash = this.credentialHash;
    if (token === undefined || credentialHash === undefined || !matchesDigest(token, credentialHash)) {
      this.writeText(response, 403, "Forbidden");
      return;
    }
    this.pruneSessions();
    if (this.sessions.size >= MAX_SESSIONS) {
      this.writeText(response, 429, "Too many active approval sessions");
      return;
    }
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader("Set-Cookie", `dsh_devkit_approval_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private pruneSessions(now = Date.now()): void {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }

  private async resolveApproval(request: IncomingMessage, response: ServerResponse, encodedId: string): Promise<void> {
    const session = this.session(request);
    if (session === undefined) return this.writeText(response, 401, "Authentication required");
    let approvalId: string;
    try { approvalId = decodeURIComponent(encodedId); } catch { return this.writeText(response, 400, "Invalid approval"); }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(approvalId)) return this.writeText(response, 400, "Invalid approval");
    const form = await readForm(request);
    const csrf = form === undefined ? undefined : formValue(form, "csrf");
    const decision = form === undefined ? undefined : formValue(form, "decision");
    if (csrf === undefined || !sameSecret(csrf, session.csrf) || (decision !== "accept" && decision !== "decline")) return this.writeText(response, 403, "Forbidden");
    const pending = this.options.broker.pending().find(value => value.approvalId === approvalId);
    if (pending === undefined) return this.writeText(response, 409, "Approval is no longer pending");
    const resolved = this.options.broker.resolve({
      approvalId,
      taskId: pending.request.taskId,
      fingerprint: pending.request.fingerprint,
      decision,
      operatorId: this.operatorId,
    });
    if (resolved.state !== "accepted") return this.writeText(response, 409, "Approval is no longer pending");
    response.writeHead(303, { Location: "/" });
    response.end();
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

export function createLocalApprovalControlPlane(options: LocalApprovalControlPlaneOptions): LocalApprovalControlPlane {
  return new LocalApprovalControlPlane(options);
}

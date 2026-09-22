import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DevkitError } from "../contracts/task.js";
import { LocalFindingAdjudicationBroker, type PendingFindingAdjudication } from "./local-finding-adjudication-broker.js";

const MAX_FORM_BYTES = 8 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 32;

interface Session { readonly csrf: string; readonly expiresAt: number }

export interface LocalFindingAdjudicationControlPlaneOptions {
  readonly broker: LocalFindingAdjudicationBroker;
  /** Host-owned secret callback; its value is never rendered or logged. */
  readonly credential: () => string;
  /** Audited only after the local host-secret session is authenticated. */
  readonly operatorId: string;
  readonly port?: number;
}

export interface LocalFindingAdjudicationControlPlaneInfo { readonly url: string }

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

function sameSecret(left: string, right: string): boolean {
  const a = digest(left), b = digest(right);
  try { return timingSafeEqual(a, b); } finally { a.fill(0); b.fill(0); }
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
 * Loopback-only host presentation for high-risk review adjudication. It can
 * confirm a finding for a new validation/review pass or defer it to human
 * judgement; it cannot mark the finding rejected or delivery accepted.
 */
export class LocalFindingAdjudicationControlPlane {
  private readonly port: number;
  private readonly operatorId: string;
  private readonly sessions = new Map<string, Session>();
  private server: Server | undefined;
  private origin: string | undefined;
  private credentialHash: Buffer | undefined;
  private closed = false;

  constructor(private readonly options: LocalFindingAdjudicationControlPlaneOptions) {
    if (!Number.isSafeInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new DevkitError("INVALID_FINDING_ADJUDICATION_CONTROL_PLANE_PORT");
    if (typeof options.operatorId !== "string" || !validOperatorId(options.operatorId)) throw new DevkitError("INVALID_FINDING_ADJUDICATION_OPERATOR");
    this.port = options.port ?? 0;
    this.operatorId = options.operatorId;
  }

  async start(): Promise<LocalFindingAdjudicationControlPlaneInfo> {
    if (this.origin !== undefined) return { url: this.origin };
    if (this.closed) throw new DevkitError("FINDING_ADJUDICATION_CONTROL_PLANE_CLOSED");
    let credential: string;
    try { credential = this.options.credential(); } catch { throw new DevkitError("FINDING_ADJUDICATION_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE"); }
    if (typeof credential !== "string" || credential.length < 32 || credential.length > 4096 || credential.includes("\0")) throw new DevkitError("FINDING_ADJUDICATION_CONTROL_PLANE_CREDENTIAL_UNAVAILABLE");
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
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") throw new DevkitError("FINDING_ADJUDICATION_CONTROL_PLANE_BIND_FAILED");
      this.server = server;
      this.origin = `http://127.0.0.1:${address.port}`;
      return { url: this.origin };
    } catch (error) {
      this.credentialHash.fill(0);
      this.credentialHash = undefined;
      try { server.close(); } catch { /* the listener was never available */ }
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("FINDING_ADJUDICATION_CONTROL_PLANE_BIND_FAILED");
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
      if (request.method === "POST" && url.pathname.startsWith("/adjudications/")) return await this.resolveFinding(request, response, url.pathname.slice("/adjudications/".length));
      return this.writeText(response, 404, "Not found");
    } catch {
      if (!response.headersSent) this.writeText(response, 500, "Internal error");
      else response.end();
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const requested = request.headers.origin;
    return this.origin !== undefined && (requested === undefined || requested === this.origin);
  }

  private session(request: IncomingMessage): Session | undefined {
    this.pruneSessions();
    const id = cookieValue(request, "dsh_devkit_finding_adjudication_session");
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
      this.writeHtml(response, 200, "<!doctype html><meta charset=utf-8><title>DSH DevKit adjudication</title><h1>DSH DevKit adjudication</h1><form method=post action=/session><label>Local adjudication secret <input name=token type=password autocomplete=current-password required></label><button type=submit>Open adjudication controls</button></form>");
      return;
    }
    const pending = this.options.broker.pending();
    const cards = pending.length === 0 ? "<p>No pending high-risk findings.</p>" : pending.map(value => this.renderFinding(value, session.csrf)).join("\n");
    this.writeHtml(response, 200, `<!doctype html><meta charset=utf-8><title>DSH DevKit adjudication</title><h1>High-risk review findings</h1><p>Confirming a finding only requires a new repair, validation, and review pass. It cannot accept delivery.</p>${cards}`);
  }

  private renderFinding(pending: PendingFindingAdjudication, csrf: string): string {
    const request = pending.request;
    const finding = request.finding;
    const action = `/adjudications/${encodeURIComponent(pending.approvalId)}`;
    const evidence = finding.evidence.length === 0 ? "(no review evidence supplied)" : finding.evidence.join("\n\n");
    return `<article><h2>${escapeHtml(finding.severity)} · ${escapeHtml(finding.title)}</h2><p>Task: ${escapeHtml(request.taskId)}</p><p>Retained run: ${escapeHtml(request.runId)}</p><p>Snapshot: ${escapeHtml(request.snapshotId)}</p><p>Location: ${escapeHtml(finding.path)}:${finding.line} (${escapeHtml(finding.ruleId)})</p><h3>Trigger</h3><pre>${escapeHtml(finding.trigger)}</pre><h3>Impact</h3><pre>${escapeHtml(finding.impact)}</pre><h3>Review evidence</h3><pre>${escapeHtml(evidence)}</pre><p>Expires: ${escapeHtml(pending.expiresAt)}</p><form method=post action="${action}"><input type=hidden name=csrf value="${escapeHtml(csrf)}"><label><input type=checkbox name=confirmRequiresRepair value=yes> I reviewed this finding and require a new repair/validation/review pass.</label><button name=action value=confirm type=submit>Confirm finding</button><button name=action value=defer type=submit>Leave for human review</button></form></article>`;
  }

  private async createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const token = form === undefined ? undefined : formValue(form, "token");
    const credentialHash = this.credentialHash;
    if (token === undefined || credentialHash === undefined || !matchesDigest(token, credentialHash)) return this.writeText(response, 403, "Forbidden");
    this.pruneSessions();
    if (this.sessions.size >= MAX_SESSIONS) return this.writeText(response, 429, "Too many active adjudication sessions");
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader("Set-Cookie", `dsh_devkit_finding_adjudication_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private async resolveFinding(request: IncomingMessage, response: ServerResponse, encodedId: string): Promise<void> {
    const session = this.session(request);
    if (session === undefined) return this.writeText(response, 401, "Authentication required");
    let approvalId: string;
    try { approvalId = decodeURIComponent(encodedId); } catch { return this.writeText(response, 400, "Invalid adjudication"); }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(approvalId)) return this.writeText(response, 400, "Invalid adjudication");
    const form = await readForm(request);
    const csrf = form === undefined ? undefined : formValue(form, "csrf");
    const action = form === undefined ? undefined : formValue(form, "action");
    const confirmRequiresRepair = form === undefined ? undefined : formValue(form, "confirmRequiresRepair");
    if (csrf === undefined || !sameSecret(csrf, session.csrf) || (action !== "confirm" && action !== "defer") || (action === "confirm" && confirmRequiresRepair !== "yes")) return this.writeText(response, 403, "Forbidden");
    const pending = this.options.broker.pending().find(value => value.approvalId === approvalId);
    if (pending === undefined) return this.writeText(response, 409, "Adjudication is no longer pending");
    const resolved = this.options.broker.resolve({
      approvalId,
      taskId: pending.request.taskId,
      runId: pending.request.runId,
      snapshotId: pending.request.snapshotId,
      findingFingerprint: pending.request.findingFingerprint,
      fingerprint: pending.request.fingerprint,
      action,
      operatorId: this.operatorId,
    });
    if (resolved.state !== "accepted") return this.writeText(response, 409, "Adjudication is no longer pending");
    response.writeHead(303, { Location: "/" });
    response.end();
  }

  private pruneSessions(now = Date.now()): void {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
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

export function createLocalFindingAdjudicationControlPlane(options: LocalFindingAdjudicationControlPlaneOptions): LocalFindingAdjudicationControlPlane {
  return new LocalFindingAdjudicationControlPlane(options);
}

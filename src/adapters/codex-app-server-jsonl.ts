import { createInterface, type Interface } from "node:readline";
import type { AppServerSubprocessHandle } from "./macos-seatbelt-app-server.js";

const MAX_JSONL_LINE_BYTES = 256 * 1024;

export type CodexAppServerJsonObject = Record<string, unknown>;
export type CodexAppServerRpcId = string | number;

export interface CodexAppServerRequest {
  readonly id: CodexAppServerRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

/** A stable, non-sensitive protocol failure code for App Server clients. */
export class CodexAppServerProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CodexAppServerProtocolError";
  }
}

export function codexAppServerRecord(value: unknown): CodexAppServerJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CodexAppServerJsonObject : undefined;
}

export function codexAppServerBoundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0") ? value : undefined;
}

function rpcId(value: unknown): CodexAppServerRpcId | undefined {
  if (typeof value === "string") return value.length > 0 && value.length <= 200 && !value.includes("\0") ? value : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function codexAppServerRpcIdKey(value: CodexAppServerRpcId): string {
  return `${typeof value}:${String(value)}`;
}

/** Bounded protocol clients use this to settle one server lifecycle event once. */
export class CodexAppServerDeferred<T> {
  readonly promise: Promise<T>;
  private settled = false;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise(value);
  }

  reject(reason: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(reason);
  }
}

/**
 * Minimal strict JSONL transport for the stable App Server protocol surface.
 * It contains no App Server feature policy: callers must explicitly decide
 * which requests and notifications they support.
 */
export class CodexAppServerJsonlConnection {
  private readonly pending = new Map<string, CodexAppServerDeferred<unknown>>();
  private readonly lines: Interface;
  private nextId = 1;
  private disposed = false;
  private failed = false;

  constructor(
    private readonly child: AppServerSubprocessHandle,
    private readonly handlers: {
      onServerRequest: (request: CodexAppServerRequest) => Promise<void>;
      onNotification: (notification: CodexAppServerNotification) => void;
      onFailure: (error: CodexAppServerProtocolError) => void;
    },
  ) {
    if (child.stdin === undefined || child.stdout === undefined) throw new CodexAppServerProtocolError("CODEX_APP_SERVER_STREAMS_UNAVAILABLE");
    this.lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.lines.on("line", (line) => { void this.receive(line); });
    this.lines.on("close", () => {
      if (!this.disposed) this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_STREAM_CLOSED"));
    });
    child.stdout.on("error", () => this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_STREAM_FAILED")));
    child.stdin.on("error", () => this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_STREAM_FAILED")));
  }

  async request(method: string, params: CodexAppServerJsonObject): Promise<unknown> {
    const id = this.nextId++;
    const deferred = new CodexAppServerDeferred<unknown>();
    this.pending.set(codexAppServerRpcIdKey(id), deferred);
    try {
      await this.send({ method, id, params });
    } catch (error) {
      this.pending.delete(codexAppServerRpcIdKey(id));
      deferred.reject(error);
    }
    return deferred.promise;
  }

  notify(method: string, params: CodexAppServerJsonObject): Promise<void> {
    return this.send({ method, params });
  }

  respond(id: CodexAppServerRpcId, result: CodexAppServerJsonObject): Promise<void> {
    return this.send({ id, result });
  }

  respondError(id: CodexAppServerRpcId, code: number, message: string): Promise<void> {
    return this.send({ id, error: { code, message } });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
    for (const deferred of this.pending.values()) deferred.reject(new CodexAppServerProtocolError("CODEX_APP_SERVER_CONNECTION_CLOSED"));
    this.pending.clear();
  }

  private async send(message: CodexAppServerJsonObject): Promise<void> {
    if (this.disposed || this.failed || this.child.stdin === undefined) throw new CodexAppServerProtocolError("CODEX_APP_SERVER_CONNECTION_CLOSED");
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) throw new CodexAppServerProtocolError("CODEX_APP_SERVER_MESSAGE_TOO_LARGE");
    const input = this.child.stdin;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const complete = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        input.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => complete(error);
      input.once("error", onError);
      try {
        input.write(`${line}\n`, complete);
      } catch (error) {
        complete(error instanceof Error ? error : new CodexAppServerProtocolError("CODEX_APP_SERVER_STREAM_FAILED"));
      }
    });
  }

  private async receive(line: string): Promise<void> {
    if (this.disposed || this.failed) return;
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_MESSAGE_TOO_LARGE"));
      return;
    }
    let message: CodexAppServerJsonObject | undefined;
    try {
      message = codexAppServerRecord(JSON.parse(line));
    } catch {
      this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_INVALID_JSON"));
      return;
    }
    if (message === undefined) {
      this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_INVALID_MESSAGE"));
      return;
    }
    const method = codexAppServerBoundedText(message.method, 200);
    const hasId = Object.hasOwn(message, "id");
    const id = hasId ? rpcId(message.id) : undefined;
    if (method !== undefined) {
      if (hasId) {
        if (id === undefined) this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_INVALID_REQUEST_ID"));
        else {
          try {
            await this.handlers.onServerRequest({ id, method, params: message.params });
          } catch {
            this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_REQUEST_HANDLER_FAILED"));
          }
        }
      } else {
        try {
          this.handlers.onNotification({ method, params: message.params });
        } catch {
          this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_NOTIFICATION_HANDLER_FAILED"));
        }
      }
      return;
    }
    if (!hasId || id === undefined) {
      this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_INVALID_MESSAGE"));
      return;
    }
    const deferred = this.pending.get(codexAppServerRpcIdKey(id));
    if (deferred === undefined) {
      this.fail(new CodexAppServerProtocolError("CODEX_APP_SERVER_UNKNOWN_RESPONSE"));
      return;
    }
    this.pending.delete(codexAppServerRpcIdKey(id));
    if (Object.hasOwn(message, "error")) {
      deferred.reject(new CodexAppServerProtocolError("CODEX_APP_SERVER_RPC_ERROR"));
    } else if (Object.hasOwn(message, "result")) {
      deferred.resolve(message.result);
    } else {
      deferred.reject(new CodexAppServerProtocolError("CODEX_APP_SERVER_INVALID_RESPONSE"));
    }
  }

  private fail(error: CodexAppServerProtocolError): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    try { this.handlers.onFailure(error); } catch { /* pending requests still fail below */ }
    for (const deferred of this.pending.values()) deferred.reject(error);
    this.pending.clear();
  }
}

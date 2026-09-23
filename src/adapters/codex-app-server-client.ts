import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { hash } from "../contracts/task.js";
import { redact, resolveRealWithin } from "../domain/security.js";
import type { CodeExecutor, ExecutionRequest, ExecutionResult } from "../plugins/tasks.js";
import { dshCodexPrompt } from "./executor-dsh-codex.js";
import {
  CodexAppServerDeferred as Deferred,
  CodexAppServerJsonlConnection as JsonlConnection,
  CodexAppServerProtocolError as ProtocolError,
  codexAppServerBoundedText,
  codexAppServerRecord,
  codexAppServerRpcIdKey,
  type CodexAppServerRequest as ServerRequest,
} from "./codex-app-server-jsonl.js";
import type { AppServerSubprocessHandle } from "./macos-seatbelt-app-server.js";

const MAX_RPC_TEXT_CHARS = 16 * 1024;
const MAX_PENDING_PROTOCOL_EVENTS = 100;
const MAX_CACHED_APPROVAL_ITEMS = 256;
const CLIENT_INFO = { name: "dsh_devkit", title: "DSH DevKit", version: "0.1.0" } as const;

type JsonObject = Record<string, unknown>;
type ApprovalDecision = "accept" | "decline";

export interface PreparedCodexAppServerClient {
  /** The already-started App Server child, owned solely by this launch. */
  readonly child: AppServerSubprocessHandle;
  /**
   * Releases host-owned launch state only after the caller proves that its
   * child process stopped. A false result is fail-closed.
   */
  release(stopped: boolean): Promise<boolean> | boolean;
}

/**
 * Trusted host launch seam. It deliberately has no task-controlled argv,
 * environment, credential, or network fields.
 */
export interface CodexAppServerClientLaunch {
  readonly id: string;
  prepare(workspace: string, signal: AbortSignal): Promise<PreparedCodexAppServerClient>;
}

export interface CodexAppServerApprovalRequest {
  readonly taskId: string;
  readonly kind: "command" | "file-change";
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  /** Stable hash binding the answer to this exact request. */
  readonly fingerprint: string;
  readonly cwd: string;
  readonly reason?: string;
  readonly command?: string;
  /** Only paths already inside the task's allowed write scope are exposed. */
  readonly paths?: readonly string[];
}

/**
 * A host-only interactive approval bridge. It is intentionally not a DSH
 * tool, so a model cannot submit a self-approval. Implementations may only
 * return a single-request accept or decline; session-wide grants are excluded.
 */
export interface CodexAppServerApprovalBroker {
  decide(request: CodexAppServerApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface CodexAppServerExecutorOptions {
  readonly launch: CodexAppServerClientLaunch;
  /** Omission is safe: every elevation request is declined. */
  readonly approvalBroker?: CodexAppServerApprovalBroker;
  readonly clientInfo?: { readonly name: string; readonly title: string; readonly version: string };
}

function record(value: unknown): JsonObject | undefined {
  return codexAppServerRecord(value);
}

function boundedText(value: unknown, limit = MAX_RPC_TEXT_CHARS): string | undefined {
  return codexAppServerBoundedText(value, limit);
}

function rpcIdKey(value: ServerRequest["id"]): string {
  return codexAppServerRpcIdKey(value);
}

function canonicalDirectory(value: string): string | undefined {
  try {
    const resolved = realpathSync(value);
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalWithin(root: string, value: unknown): string | undefined {
  const candidate = boundedText(value, 4096);
  if (candidate === undefined || !path.isAbsolute(candidate)) return undefined;
  const resolved = canonicalDirectory(candidate);
  return resolved !== undefined && isWithin(root, resolved) ? resolved : undefined;
}

function allowedRelativePath(workspace: string, value: unknown, allowedPaths: readonly string[]): string | undefined {
  const candidate = boundedText(value, 4096);
  if (candidate === undefined) return undefined;
  let relative: string;
  if (path.isAbsolute(candidate)) {
    relative = path.relative(workspace, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  } else {
    relative = candidate;
  }
  try {
    const resolved = resolveRealWithin(workspace, relative);
    const normalized = path.relative(workspace, resolved).split(path.sep).join("/");
    return allowedPaths.some((entry) => normalized === entry || (entry.endsWith("/") && normalized.startsWith(entry))) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

interface FileChangeItem { readonly paths: readonly string[] }
interface CommandExecutionItem { readonly command: string; readonly cwd: string }

function currentApprovalContext(params: unknown, threadId: string | undefined, turnId: string | undefined): { readonly itemId: string; readonly values: JsonObject } | undefined {
  const values = record(params);
  if (values === undefined || threadId === undefined || turnId === undefined) return undefined;
  if (boundedText(values.threadId, 200) !== threadId || boundedText(values.turnId, 200) !== turnId) return undefined;
  const itemId = boundedText(values.itemId, 200);
  return itemId === undefined ? undefined : { itemId, values };
}

function fileChangePaths(item: unknown, workspace: string, allowedPaths: readonly string[]): readonly string[] | undefined {
  const values = record(item);
  if (values === undefined || values.type !== "fileChange" || !Array.isArray(values.changes) || values.changes.length < 1 || values.changes.length > 100) return undefined;
  const paths: string[] = [];
  for (const change of values.changes) {
    const changeValues = record(change);
    const safe = changeValues === undefined ? undefined : allowedRelativePath(workspace, changeValues.path, allowedPaths);
    if (safe === undefined) return undefined;
    paths.push(safe);
  }
  return [...new Set(paths)].sort();
}

function turnStatus(params: unknown, expectedThreadId: string | undefined, expectedTurnId: string | undefined): "completed" | "interrupted" | "failed" | undefined {
  const values = record(params);
  const turn = values === undefined ? undefined : record(values.turn);
  if (values === undefined || turn === undefined || expectedThreadId === undefined || expectedTurnId === undefined) return undefined;
  if (boundedText(values.threadId, 200) !== expectedThreadId) return undefined;
  if (boundedText(turn.id, 200) !== expectedTurnId) return undefined;
  const status = boundedText(turn.status, 100);
  return status === "completed" || status === "interrupted" || status === "failed" ? status : undefined;
}

function turnIdFrom(result: unknown): string | undefined {
  const resultValues = record(result);
  const turn = resultValues === undefined ? undefined : record(resultValues.turn);
  return turn === undefined ? undefined : boundedText(turn.id, 200);
}

function threadIdFrom(result: unknown): string | undefined {
  const resultValues = record(result);
  const thread = resultValues === undefined ? undefined : record(resultValues.thread);
  if (thread === undefined || thread.ephemeral !== true) return undefined;
  return boundedText(thread.id, 200);
}

function safeReason(value: unknown): string | undefined {
  const reason = boundedText(value, 4096);
  return reason === undefined ? undefined : redact(reason);
}

async function waitForAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new ProtocolError("CANCELLED");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new ProtocolError("CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      result => { signal.removeEventListener("abort", onAbort); resolve(result); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * Direct App Server client for a DevKit candidate workspace. Unlike the DSH
 * provider, this owns the JSON-RPC client side of approvals. It starts only
 * through a host-provided launch seam and has no ambient credential fallback.
 */
export class CodexAppServerExecutor implements CodeExecutor {
  readonly family = "codex-app-server-client";
  readonly kind = "live" as const;
  private readonly clientInfo: { readonly name: string; readonly title: string; readonly version: string };

  constructor(private readonly options: CodexAppServerExecutorOptions) {
    this.clientInfo = options.clientInfo ?? CLIENT_INFO;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const workspace = canonicalDirectory(request.workspace);
    if (workspace === undefined) return { stopped: true, failure: "CODEX_WORKSPACE_BINDING_UNAVAILABLE" };
    if (request.signal.aborted) return { stopped: true, failure: "CANCELLED" };

    let prepared: PreparedCodexAppServerClient | undefined;
    let connection: JsonlConnection | undefined;
    let threadId: string | undefined;
    let activeTurnId: string | undefined;
    let failure: string | undefined;
    let stopped = true;
    const terminal = new Deferred<"completed" | "interrupted" | "failed">();
    const fileItems = new Map<string, FileChangeItem>();
    const commandItems = new Map<string, CommandExecutionItem>();
    // A server is permitted to stream a server-initiated request immediately
    // after it writes the turn/start response. Buffer it until the response's
    // turn id has become our active binding; declining merely because of that
    // transport race would make an otherwise valid human approval unreliable.
    const pendingServerRequests: ServerRequest[] = [];
    const pendingTurnCompletions: unknown[] = [];
    const pendingItemStarts: unknown[] = [];
    let serverRequestsReady = false;

    const settleTurn = (params: unknown) => {
      const status = turnStatus(params, threadId, activeTurnId);
      if (status !== undefined) terminal.resolve(status);
    };

    const cacheApprovalItem = (params: unknown) => {
      const values = record(params);
      if (values === undefined || threadId === undefined || activeTurnId === undefined) return;
      // Item notifications are trusted only when the server explicitly binds
      // them to this one ephemeral thread and turn. A cache miss simply makes
      // a later file-change approval decline.
      if (boundedText(values.threadId, 200) !== threadId || boundedText(values.turnId, 200) !== activeTurnId) return;
      const item = record(values.item);
      const itemId = item === undefined ? undefined : boundedText(item.id, 200);
      if (item === undefined || itemId === undefined) return;
      const totalItems = fileItems.size + commandItems.size;
      const canStore = fileItems.has(itemId) || commandItems.has(itemId) || totalItems < MAX_CACHED_APPROVAL_ITEMS;
      if (!canStore) return;
      if (item.type === "fileChange") {
        const paths = fileChangePaths(item, workspace, request.allowedPaths);
        if (paths !== undefined) fileItems.set(itemId, { paths });
        return;
      }
      if (item.type !== "commandExecution") return;
      const command = boundedText(item.command);
      const cwd = canonicalWithin(workspace, item.cwd);
      if (command !== undefined && cwd !== undefined) commandItems.set(itemId, { command, cwd });
    };

    try {
      prepared = await this.options.launch.prepare(workspace, request.signal);
      stopped = false;
      const child = prepared.child;
      connection = new JsonlConnection(child, {
        onFailure: error => terminal.reject(error),
        onNotification: notification => {
          if (notification.method === "item/started") {
            if (activeTurnId === undefined) {
              if (pendingItemStarts.length < MAX_PENDING_PROTOCOL_EVENTS) pendingItemStarts.push(notification.params);
              else terminal.reject(new ProtocolError("CODEX_APP_SERVER_NOTIFICATION_OVERFLOW"));
            } else cacheApprovalItem(notification.params);
          }
          if (notification.method === "turn/completed") {
            if (activeTurnId === undefined) {
              if (pendingTurnCompletions.length < MAX_PENDING_PROTOCOL_EVENTS) pendingTurnCompletions.push(notification.params);
              else terminal.reject(new ProtocolError("CODEX_APP_SERVER_NOTIFICATION_OVERFLOW"));
            }
            else settleTurn(notification.params);
          }
        },
        onServerRequest: async serverRequest => {
          if (!serverRequestsReady) {
            if (pendingServerRequests.length < MAX_PENDING_PROTOCOL_EVENTS) pendingServerRequests.push(serverRequest);
            else await connection!.respondError(serverRequest.id, -32000, "DevKit App Server request queue saturated");
            return;
          }
          await this.respondToServerRequest(connection!, serverRequest, { request, workspace, threadId, turnId: activeTurnId, fileItems, commandItems });
        },
      });

      const initialized = await waitForAbort(connection.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: false, requestAttestation: false },
      }), request.signal);
      if (record(initialized) === undefined) throw new ProtocolError("CODEX_APP_SERVER_INITIALIZE_INVALID");
      await waitForAbort(connection.notify("initialized", {}), request.signal);
      const startedThread = await waitForAbort(connection.request("thread/start", {
        cwd: workspace,
        ephemeral: true,
        approvalPolicy: "onRequest",
        approvalsReviewer: "user",
        sandbox: "workspaceWrite",
      }), request.signal);
      threadId = threadIdFrom(startedThread);
      if (threadId === undefined) throw new ProtocolError("CODEX_APP_SERVER_THREAD_INVALID");
      const input = dshCodexPrompt(request)[0];
      if (input?.type !== "text") throw new ProtocolError("CODEX_APP_SERVER_PROMPT_INVALID");
      const startedTurn = await waitForAbort(connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.text }],
        cwd: workspace,
        approvalPolicy: "onRequest",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace],
          readOnlyAccess: { type: "restricted", includePlatformDefaults: true, readableRoots: [workspace] },
          networkAccess: false,
        },
      }), request.signal);
      activeTurnId = turnIdFrom(startedTurn);
      if (activeTurnId === undefined) throw new ProtocolError("CODEX_APP_SERVER_TURN_INVALID");
      serverRequestsReady = true;
      for (const itemStarted of pendingItemStarts.splice(0)) cacheApprovalItem(itemStarted);
      for (const serverRequest of pendingServerRequests.splice(0)) {
        await this.respondToServerRequest(connection, serverRequest, { request, workspace, threadId, turnId: activeTurnId, fileItems, commandItems });
      }
      for (const completion of pendingTurnCompletions.splice(0)) settleTurn(completion);
      const status = await waitForAbort(terminal.promise, request.signal);
      if (status !== "completed") failure = status === "interrupted" ? "CODEX_APP_SERVER_TURN_INTERRUPTED" : "CODEX_APP_SERVER_TURN_FAILED";
    } catch (error) {
      failure = request.signal.aborted
        ? "CANCELLED"
        : error instanceof ProtocolError
          ? error.code
          : "CODEX_APP_SERVER_EXECUTION_FAILED";
    } finally {
      if (prepared !== undefined) {
        if (request.signal.aborted && connection !== undefined && threadId !== undefined && activeTurnId !== undefined) {
          try { await connection.notify("turn/interrupt", { threadId, turnId: activeTurnId }); } catch { /* child teardown remains authoritative */ }
        }
        connection?.dispose();
        try { prepared.child.terminate(); } catch { /* waitForExit below determines proof */ }
        try { stopped = await prepared.child.waitForExit(); } catch { stopped = false; }
        try {
          if (!await prepared.release(stopped)) {
            stopped = false;
            failure ??= "CODEX_APP_SERVER_RELEASE_UNCONFIRMED";
          }
        } catch {
          stopped = false;
          failure ??= "CODEX_APP_SERVER_RELEASE_UNCONFIRMED";
        }
      }
    }

    const runId = threadId !== undefined && activeTurnId !== undefined ? `${threadId}:${activeTurnId}` : undefined;
    if (!stopped) return { stopped: false, ...(runId === undefined ? {} : { runId }), failure: failure ?? "CODEX_APP_SERVER_EXIT_UNCONFIRMED" };
    return { stopped: true, ...(runId === undefined ? {} : { runId }), ...(failure === undefined ? {} : { failure }) };
  }

  private async respondToServerRequest(
    connection: JsonlConnection,
    serverRequest: ServerRequest,
    context: {
      readonly request: ExecutionRequest;
      readonly workspace: string;
      readonly threadId: string | undefined;
      readonly turnId: string | undefined;
      readonly fileItems: ReadonlyMap<string, FileChangeItem>;
      readonly commandItems: ReadonlyMap<string, CommandExecutionItem>;
    },
  ): Promise<void> {
    switch (serverRequest.method) {
      case "item/commandExecution/requestApproval": {
        const current = currentApprovalContext(serverRequest.params, context.threadId, context.turnId);
        const cached = current === undefined ? undefined : context.commandItems.get(current.itemId);
        const hasCommand = current !== undefined && Object.hasOwn(current.values, "command");
        const hasCwd = current !== undefined && Object.hasOwn(current.values, "cwd");
        const requestedCommand = current === undefined ? undefined : boundedText(current.values.command);
        const requestedCwd = current === undefined ? undefined : canonicalWithin(context.workspace, current.values.cwd);
        const command = requestedCommand ?? cached?.command;
        const cwd = requestedCwd ?? cached?.cwd;
        const itemMatchesRequest = cached === undefined
          || (!hasCommand || requestedCommand === cached.command)
            && (!hasCwd || requestedCwd === cached.cwd);
        // A one-time human answer may approve only the exact command in the
        // existing turn sandbox. Never use it to accept a network grant,
        // additional filesystem permissions, or an exec-policy amendment.
        const elevationRequested = current?.values.networkApprovalContext !== undefined
          || current?.values.additionalPermissions !== undefined
          || current?.values.proposedExecpolicyAmendment !== undefined
          || current?.values.commandActions !== undefined;
        const reason = current === undefined ? undefined : safeReason(current.values.reason);
        const decision = current === undefined || (hasCommand && requestedCommand === undefined) || (hasCwd && requestedCwd === undefined)
          || cwd === undefined || elevationRequested || command === undefined || !itemMatchesRequest
          ? "decline"
          : await this.humanDecision({
            taskId: context.request.task.taskId,
            kind: "command",
            requestId: rpcIdKey(serverRequest.id),
            threadId: context.threadId!,
            turnId: context.turnId!,
            itemId: current.itemId,
            cwd,
            command: redact(command),
            ...(reason === undefined ? {} : { reason }),
            fingerprint: hash({ version: 1, kind: "command", taskId: context.request.task.taskId, threadId: context.threadId, turnId: context.turnId, itemId: current.itemId, cwd, command }),
          }, context.request.signal);
        await connection.respond(serverRequest.id, { decision });
        return;
      }
      case "item/fileChange/requestApproval": {
        const current = currentApprovalContext(serverRequest.params, context.threadId, context.turnId);
        const item = current === undefined ? undefined : context.fileItems.get(current.itemId);
        const grantRoot = current?.values.grantRoot;
        const grantRootAllowed = grantRoot === undefined || canonicalWithin(context.workspace, grantRoot) !== undefined;
        const reason = current === undefined ? undefined : safeReason(current.values.reason);
        const decision = current === undefined || item === undefined || !grantRootAllowed
          ? "decline"
          : await this.humanDecision({
            taskId: context.request.task.taskId,
            kind: "file-change",
            requestId: rpcIdKey(serverRequest.id),
            threadId: context.threadId!,
            turnId: context.turnId!,
            itemId: current.itemId,
            cwd: context.workspace,
            paths: item.paths,
            ...(reason === undefined ? {} : { reason }),
            fingerprint: hash({ version: 1, kind: "file-change", taskId: context.request.task.taskId, threadId: context.threadId, turnId: context.turnId, itemId: current.itemId, cwd: context.workspace, paths: item.paths }),
          }, context.request.signal);
        await connection.respond(serverRequest.id, { decision });
        return;
      }
      case "item/permissions/requestApproval":
        // DevKit has no policy for per-turn permission expansion. Never turn a
        // human click into a broad filesystem or network grant.
        await connection.respond(serverRequest.id, { permissions: {}, scope: "turn" });
        return;
      case "item/tool/requestUserInput":
        // This response shape is intentionally empty rather than a generic
        // cancel object: App Server treats it as no supplied answers and never
        // lets a task solicit arbitrary host data.
        await connection.respond(serverRequest.id, { answers: {} });
        return;
      case "mcpServer/elicitation/request":
        // A task writer cannot obtain arbitrary secrets or side-effecting app
        // access by manufacturing a user-input prompt.
        await connection.respond(serverRequest.id, { action: "decline", content: null, _meta: null });
        return;
      default:
        await connection.respondError(serverRequest.id, -32601, "Unsupported DevKit App Server request");
    }
  }

  private async humanDecision(approval: CodexAppServerApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.options.approvalBroker === undefined || signal.aborted) return "decline";
    try {
      return await this.options.approvalBroker.decide(approval, signal) === "accept" ? "accept" : "decline";
    } catch {
      return "decline";
    }
  }
}

export function createCodexAppServerExecutor(options: CodexAppServerExecutorOptions): CodexAppServerExecutor {
  return new CodexAppServerExecutor(options);
}

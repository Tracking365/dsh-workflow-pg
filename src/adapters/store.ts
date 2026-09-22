import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DevkitError, hash, type TaskInput, type TaskRecord } from "../contracts/task.js";
import { assertTransition } from "../domain/state-machine.js";

type Patch = Partial<Pick<TaskRecord, "status" | "stage" | "retryCount" | "readyForAcceptance" | "reason" | "workspace" | "baseCommit" | "snapshotId" | "runId">>;
export interface TaskEvent { seq: number; type: string; time: string; payload: unknown }
/** A durable writer ownership record. It is intentionally retained after a crash. */
export interface TaskLease { readonly resource: string; readonly runId: string; readonly acquiredAt: string }

function sqlRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DevkitError("STORE_CORRUPT");
  return value as Record<string, unknown>;
}
function textColumn(value: unknown): string {
  if (typeof value !== "string") throw new DevkitError("STORE_CORRUPT");
  return value;
}
function numberColumn(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DevkitError("STORE_CORRUPT");
  return value;
}
function parseRecord(value: unknown): TaskRecord {
  try { return JSON.parse(textColumn(value)) as TaskRecord; }
  catch { throw new DevkitError("STORE_CORRUPT"); }
}
export class TaskStore {
  private readonly db: DatabaseSync;
  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try { if (lstatSync(filename).isSymbolicLink()) throw new DevkitError("STORE_SYMLINK"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
      const version = numberColumn(sqlRow(this.db.prepare("PRAGMA user_version").get()).user_version);
      if (version !== 0 && version !== 1) throw new DevkitError("STORE_SCHEMA_UNSUPPORTED");
      if (version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (tables.length) throw new DevkitError("STORE_MIGRATION_REQUIRED");
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE tasks (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, input_hash TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL);
            CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE leases (resource TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL, acquired_at TEXT NOT NULL);
            PRAGMA user_version=1;
          `);
        });
      }
      this.db.prepare("SELECT id FROM tasks LIMIT 1").all(); // Never replace a malformed store.
      this.db.exec("PRAGMA journal_mode=WAL;");
      // A reopened host cannot prove that a process from the prior runtime has
      // stopped. Preserve its lease and make the uncertainty visible instead
      // of allowing the task to look runnable or silently reclaiming it.
      this.recoverUnfinishedRuns();
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  create(input: TaskInput, policyHash: string, baseCommit?: string): TaskRecord {
    const inputHash = hash(input);
    return this.transaction(() => {
      if (input.idempotencyKey) {
        const row = this.db.prepare("SELECT record FROM tasks WHERE idempotency_key=?").get(input.idempotencyKey);
        if (row) {
          const existing = parseRecord(sqlRow(row).record);
          if (existing.inputHash !== inputHash || existing.policyHash !== policyHash) throw new DevkitError("IDEMPOTENCY_CONFLICT");
          return existing;
        }
      }
      const now = new Date().toISOString();
      const record: TaskRecord = { schemaVersion: 1, taskId: randomUUID(), inputHash, input, policyHash, ...(baseCommit ? { baseCommit } : {}), status: "queued", stage: "preflight", retryCount: 0, readyForAcceptance: false, version: 0, createdAt: now, updatedAt: now };
      this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?)").run(record.taskId, input.idempotencyKey ?? null, inputHash, 0, JSON.stringify(record));
      this.event(record.taskId, "created", { inputHash, policyHash });
      return record;
    });
  }
  get(id: string): TaskRecord {
    const row = this.db.prepare("SELECT record FROM tasks WHERE id=?").get(id);
    if (!row) throw new DevkitError("TASK_NOT_FOUND");
    return parseRecord(sqlRow(row).record);
  }
  private event(id: string, type: string, payload: unknown): void {
    this.db.prepare("INSERT INTO events(task_id,type,time,payload) VALUES(?,?,?,?)").run(id, type, new Date().toISOString(), JSON.stringify(payload));
  }
  private change(id: string, expected: number, patch: Patch, type: string, payload: unknown): TaskRecord {
    const current = this.get(id);
    if (current.version !== expected) throw new DevkitError("VERSION_CONFLICT");
    if (patch.status && patch.status !== current.status) assertTransition(current.status, patch.status);
    const next: TaskRecord = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    if (next.readyForAcceptance && (next.status !== "awaiting_human" || next.reason !== "final_acceptance")) throw new DevkitError("INVALID_ACCEPTANCE_STATE");
    this.db.prepare("UPDATE tasks SET version=?,record=? WHERE id=? AND version=?").run(next.version, JSON.stringify(next), id, expected);
    this.event(id, type, payload);
    return next;
  }
  update(id: string, expected: number, patch: Patch, type: string, payload: unknown = {}): TaskRecord {
    return this.transaction(() => this.change(id, expected, patch, type, payload));
  }
  private leaseUnchecked(id: string): TaskLease | undefined {
    const row = this.db.prepare("SELECT resource,run_id,acquired_at FROM leases WHERE task_id=?").get(id);
    if (!row) return undefined;
    const value = sqlRow(row);
    return { resource: textColumn(value.resource), runId: textColumn(value.run_id), acquiredAt: textColumn(value.acquired_at) };
  }
  private recoverUnfinishedRuns(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT record FROM tasks").all();
      for (const row of rows) {
        let current: TaskRecord;
        try {
          current = parseRecord(sqlRow(row).record);
        } catch (error) {
          // Do not mutate or replace a corrupt row while opening the store.
          // Its ordinary `get()` path still raises STORE_CORRUPT; skipping it
          // here merely preserves the previous fail-closed diagnostic timing.
          if (error instanceof DevkitError && error.code === "STORE_CORRUPT") continue;
          throw error;
        }
        if (current.status !== "running" && current.status !== "cancelling") continue;
        const lease = this.leaseUnchecked(current.taskId);
        this.change(
          current.taskId,
          current.version,
          { status: "interrupted", readyForAcceptance: false, reason: "restart_requires_reconciliation" },
          "runtime_restarted",
          {
            ...(current.runId === undefined ? {} : { runId: current.runId }),
            leaseRetained: lease !== undefined,
            ...(lease === undefined ? { reason: "lease_missing" } : {}),
          },
        );
      }
    });
  }
  acquire(id: string, resource: string, runId: string): TaskRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (current.status !== "queued") throw new DevkitError("TASK_NOT_QUEUED");
      if (this.db.prepare("SELECT task_id FROM leases WHERE resource=? OR task_id=?").get(resource, id)) throw new DevkitError("WORKSPACE_BUSY");
      this.db.prepare("INSERT INTO leases VALUES(?,?,?,?)").run(resource, id, runId, new Date().toISOString());
      return this.change(id, current.version, { status: "running", stage: "preflight", runId, readyForAcceptance: false, reason: "preflight" }, "run_started", { runId });
    });
  }
  release(id: string, runId: string): void { this.db.prepare("DELETE FROM leases WHERE task_id=? AND run_id=?").run(id, runId); }
  hasLease(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM leases WHERE task_id=?").get(id); }
  lease(id: string): TaskLease | undefined { this.get(id); return this.leaseUnchecked(id); }
  /**
   * The caller must have independently proved that the old writer stopped.
   * Preserve its old workspace on disk and atomically queue a fresh clone;
   * stale workspace/snapshot/run references must never become current proof.
   */
  requeueRecovered(id: string, expected: number, runId: string, payload: unknown): TaskRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (current.version !== expected) throw new DevkitError("VERSION_CONFLICT");
      if (current.status !== "interrupted") throw new DevkitError("RECOVERY_TASK_NOT_INTERRUPTED");
      const lease = this.leaseUnchecked(id);
      if (!lease || lease.runId !== runId) throw new DevkitError("RECOVERY_LEASE_CHANGED");
      assertTransition(current.status, "queued");
      const { workspace: previousWorkspace, snapshotId: previousSnapshotId, runId: _previousRunId, ...retained } = current;
      const next: TaskRecord = {
        ...retained,
        status: "queued",
        stage: "preflight",
        readyForAcceptance: false,
        reason: "recovery_authorized",
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db.prepare("UPDATE tasks SET version=?,record=? WHERE id=? AND version=?").run(next.version, JSON.stringify(next), id, expected);
      this.event(id, "recovery_requeued", {
        ...((payload && typeof payload === "object" && !Array.isArray(payload)) ? payload as Record<string, unknown> : { payload }),
        ...(previousWorkspace === undefined ? {} : { previousWorkspace }),
        ...(previousSnapshotId === undefined ? {} : { previousSnapshotId }),
        retryCount: current.retryCount,
      });
      this.db.prepare("DELETE FROM leases WHERE task_id=? AND run_id=?").run(id, runId);
      return next;
    });
  }
  history(id: string): TaskEvent[] {
    this.get(id);
    return this.db.prepare("SELECT seq,type,time,payload FROM events WHERE task_id=? ORDER BY seq").all(id).map((value) => {
      const entry = sqlRow(value);
      let payload: unknown;
      try { payload = JSON.parse(textColumn(entry.payload)); }
      catch { throw new DevkitError("STORE_CORRUPT"); }
      return { seq: numberColumn(entry.seq), type: textColumn(entry.type), time: textColumn(entry.time), payload };
    });
  }
  close(): void { this.db.close(); }
}

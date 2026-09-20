import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DevkitError, hash, type TaskInput, type TaskRecord } from "../contracts/task.js";
import { assertTransition } from "../domain/state-machine.js";

type Patch = Partial<Pick<TaskRecord, "status" | "stage" | "retryCount" | "readyForAcceptance" | "reason" | "workspace" | "baseCommit" | "snapshotId" | "runId">>;
export interface TaskEvent { seq: number; type: string; time: string; payload: unknown }
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
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
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
          const existing = JSON.parse(String(row.record)) as TaskRecord;
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
    return JSON.parse(String(row.record)) as TaskRecord;
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
  history(id: string): TaskEvent[] {
    this.get(id);
    return this.db.prepare("SELECT seq,type,time,payload FROM events WHERE task_id=? ORDER BY seq").all(id).map((row) => ({ seq: Number(row.seq), type: String(row.type), time: String(row.time), payload: JSON.parse(String(row.payload)) as unknown }));
  }
  close(): void { this.db.close(); }
}

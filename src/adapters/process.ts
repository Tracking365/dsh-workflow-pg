import { spawn } from "node:child_process";
import { DevkitError } from "../contracts/task.js";
import { minimalEnvironment, redact } from "../domain/security.js";

export interface CommandSpec { readonly id: string; readonly command: string; readonly args: readonly string[]; readonly criteria: readonly string[]; readonly timeoutMs: number }
export interface CommandResult {
  checkId: string; argv: string[]; exitCode: number | null; stdout: string; stderr: string;
  classification: "passed" | "failed_assertion" | "failed_infrastructure" | "cancelled";
  tests: number; stopped: boolean; timedOut: boolean; startedAt: string; finishedAt: string;
}
/** Trusted local fixture runner only: process groups are cancellation machinery, NOT a security sandbox. */
export async function runCommand(spec: CommandSpec, cwd: string, signal: AbortSignal): Promise<CommandResult> {
  if (!spec.command || spec.command.includes("\0") || !Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new DevkitError("INVALID_COMMAND_PLAN");
  const startedAt = new Date().toISOString();
  if (signal.aborted) throw new DevkitError("CANCELLED");
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], { cwd, env: minimalEnvironment(cwd), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, overflow = false, timedOut = false, spawnError = false;
    const terminate = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") spawnError = true; }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > 131072) { overflow = true; terminate(); return; }
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", () => { spawnError = true; });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, spec.timeoutMs);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.on("close", (exitCode) => {
      clearTimeout(timer); signal.removeEventListener("abort", terminate);
      // A surviving ordinary descendant prevents a claim that execution has stopped.
      let stopped = true;
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, 0); stopped = false; terminate(); }
        catch (e) { stopped = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      } else if (signal.aborted || timedOut) stopped = false;
      const tests = Number(/^# tests (\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
      const failed = Number(/^# fail (\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
      const skipped = Number(/^# skipped (\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
      const todo = Number(/^# todo (\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
      const infrastructure = spawnError || overflow || timedOut || !stopped || tests === 0 || skipped > 0 || todo > 0;
      const classification = signal.aborted ? "cancelled" : infrastructure ? "failed_infrastructure" : exitCode === 0 && failed === 0 ? "passed" : exitCode !== 0 && failed > 0 && /ERR_ASSERTION/.test(stdout) ? "failed_assertion" : "failed_infrastructure";
      resolve({ checkId: spec.id, argv: [spec.command, ...spec.args], exitCode, stdout: redact(stdout), stderr: redact(stderr), classification, tests, stopped, timedOut, startedAt, finishedAt: new Date().toISOString() });
    });
  });
}

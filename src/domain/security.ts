import path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { DevkitError } from "../contracts/task.js";

/** Lexical validation. Call resolveRealWithin before filesystem I/O. This is NOT an OS sandbox. */
export function resolveWithin(root: string, candidate: string): string {
  if (candidate.includes("\0") || candidate.includes("\\") || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate) || path.isAbsolute(candidate)) throw new DevkitError("PATH_OUTSIDE_ALLOWED_ROOT");
  const base = path.resolve(root), resolved = path.resolve(base, candidate), relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new DevkitError("PATH_OUTSIDE_ALLOWED_ROOT");
  return resolved;
}
/** Fail closed on symlinks, including a dangling link and an existing parent of a new file. */
export function resolveRealWithin(root: string, candidate: string): string {
  const base = realpathSync(root), resolved = resolveWithin(base, candidate);
  let current = base;
  for (const part of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new DevkitError("SYMLINK_NOT_ALLOWED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existsSync(current) && realpathSync(current) !== current) throw new DevkitError("PATH_OUTSIDE_ALLOWED_ROOT");
  }
  return resolved;
}
export function rejectModelAuthority(input: Record<string, unknown>): void {
  for (const key of ["approved", "readyForAcceptance", "executionMode", "workspaceRoot"]) if (key in input) throw new DevkitError(`MODEL_CANNOT_SET_${key.toUpperCase()}`);
}
export function redact(text: string): string {
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]").replace(/((?:authorization|api[_-]?key|password|secret|token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"'}]+/gi, "$1[REDACTED]");
}
export function minimalEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TMP", "TEMP"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

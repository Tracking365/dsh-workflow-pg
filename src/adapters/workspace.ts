import { execFileSync } from "node:child_process";
import { readdirSync, lstatSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { byteHash, hash, DevkitError } from "../contracts/task.js";
import { minimalEnvironment, resolveRealWithin, redact } from "../domain/security.js";
export interface FileEntry { path: string; hash: string; size: number; mode: number }
export interface Snapshot { id: string; baseCommit: string; files: FileEntry[]; policyHash: string; planHash: string }
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { cwd, env: minimalEnvironment(cwd), encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
export function resolveBase(repository: string, ref = "HEAD"): string {
  if (ref.startsWith("-") || ref.includes("\0") || ref.includes("\n")) throw new DevkitError("INVALID_BASE_REF");
  const sha = git(repository, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new DevkitError("INVALID_BASE_COMMIT");
  const tree = git(repository, ["ls-tree", "-r", sha]);
  if (/^(120000|160000) /m.test(tree)) throw new DevkitError("UNSUPPORTED_LINK_OR_SUBMODULE");
  return sha;
}
export function prepareWorkspace(repository: string, root: string, taskId: string, baseCommit: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const work = resolveRealWithin(root, taskId);
  if (realpathSync(repository) === realpathSync(root) || realpathSync(root).startsWith(`${realpathSync(repository)}${path.sep}`)) throw new DevkitError("WORKSPACE_INSIDE_SOURCE");
  git(root, ["clone", "--no-local", "--no-checkout", "--", realpathSync(repository), work]);
  git(work, ["checkout", "--detach", baseCommit]);
  git(work, ["remote", "remove", "origin"]);
  return work;
}
export function snapshot(work: string, baseCommit: string, policyHash: string, planHash: string): Snapshot {
  const files: FileEntry[] = []; let total = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === work && name === ".git") continue;
      const absolute = path.join(dir, name), relative = path.relative(work, absolute).split(path.sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new DevkitError("UNSUPPORTED_FILE_KIND", relative);
      if (stat.isDirectory()) { if (name === ".git") throw new DevkitError("NESTED_REPOSITORY"); walk(absolute); continue; }
      total += stat.size;
      if (files.length >= 2000 || total > 16 * 1024 * 1024) throw new DevkitError("WORKSPACE_SIZE_LIMIT");
      files.push({ path: relative, hash: byteHash(readFileSync(absolute)), size: stat.size, mode: stat.mode & 0o111 ? 0o100755 : 0o100644 });
    }
  };
  walk(work);
  return { id: hash({ baseCommit, files, policyHash, planHash }), baseCommit, files, policyHash, planHash };
}
export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const a = new Map(before.files.map((f) => [f.path, hash(f)])), b = new Map(after.files.map((f) => [f.path, hash(f)]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((file) => a.get(file) !== b.get(file)).sort();
}
export function assertScope(before: Snapshot, after: Snapshot, allowed: readonly string[]): void {
  for (const file of changedFiles(before, after)) if (!allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry)))) throw new DevkitError("OUT_OF_SCOPE_CHANGE", file);
}
export function frozenHash(snap: Snapshot, protectedPaths: readonly string[]): string {
  return hash(snap.files.filter((f) => protectedPaths.some((p) => f.path === p || (p.endsWith("/") && f.path.startsWith(p)))));
}
export function exportPatch(work: string, baseCommit: string): string {
  if (git(work, ["rev-parse", "HEAD"]).trim() !== baseCommit) throw new DevkitError("GIT_HEAD_CHANGED");
  git(work, ["add", "--all", "--force", "--", "."]);
  const patch = git(work, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", baseCommit, "--"]);
  if (redact(patch) !== patch) throw new DevkitError("POSSIBLE_SECRET_IN_PATCH");
  return patch;
}
export function writeArtifact(root: string, taskId: string, filename: string, value: string): { path: string; hash: string; size: number } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = resolveRealWithin(root, taskId); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = resolveRealWithin(dir, filename);
  if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new DevkitError("ARTIFACT_SIZE_LIMIT");
  writeFileSync(output, value, { flag: "wx", mode: 0o600 });
  return { path: path.relative(root, output).split(path.sep).join("/"), hash: byteHash(value), size: Buffer.byteLength(value) };
}

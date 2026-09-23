import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DevkitError } from "../contracts/task.js";

export interface PrivateCodexStateRootOptions {
  /** Host-owned parent must already exist; the state leaf may be created. */
  readonly root: string;
  /** Existing task/control roots the credential state must never overlap. */
  readonly forbiddenRoots: readonly string[];
}

function directory(value: string, code: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new DevkitError(code);
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) throw new DevkitError(code);
    return resolved;
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError(code);
  }
}

function hostOwnedParent(value: string): string {
  const resolved = directory(value, "PRIVATE_CODEX_STATE_PARENT_UNAVAILABLE");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const metadata = statSync(resolved);
  // The private leaf may be created only beneath a directory the current host
  // user owns and that no group/other user can replace entries within.
  if (uid === undefined || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw new DevkitError("PRIVATE_CODEX_STATE_PARENT_UNSAFE");
  }
  return resolved;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

/**
 * A persistent, host-owned `$CODEX_HOME` leaf. It intentionally provides no
 * read/list/copy API: future launchers may pass its canonical path to Codex,
 * while tasks and candidate executors receive no reference to it.
 */
export class PrivateCodexStateRoot {
  readonly id = "private-codex-state-v1";
  readonly path: string;

  constructor(options: PrivateCodexStateRootOptions) {
    if (!path.isAbsolute(options.root) || options.root.includes("\0") || !options.forbiddenRoots.length) {
      throw new DevkitError("INVALID_PRIVATE_CODEX_STATE_ROOT");
    }
    const requested = path.resolve(options.root);
    const leaf = path.basename(requested);
    if (!leaf || leaf === "." || leaf === path.sep) throw new DevkitError("INVALID_PRIVATE_CODEX_STATE_ROOT");
    const parent = path.dirname(requested);
    const canonicalParent = hostOwnedParent(parent);
    const forbidden = options.forbiddenRoots.map(root => directory(root, "PRIVATE_CODEX_STATE_FORBIDDEN_ROOT_UNAVAILABLE"));
    const expectedCanonical = path.join(canonicalParent, leaf);
    // Check before mkdir so a rejected request cannot create even an empty
    // state directory below a candidate or control root.
    if (forbidden.some(root => overlaps(expectedCanonical, root))) throw new DevkitError("PRIVATE_CODEX_STATE_OVERLAPS_FORBIDDEN_ROOT");
    try {
      mkdirSync(requested, { mode: 0o700 });
      const direct = lstatSync(requested);
      if (direct.isSymbolicLink() || !direct.isDirectory()) throw new DevkitError("INVALID_PRIVATE_CODEX_STATE_ROOT");
      const canonical = realpathSync(requested);
      // The final component must be a real directory immediately below the
      // canonical parent; a link/reparse point cannot redirect CODEX_HOME.
      if (canonical !== expectedCanonical) throw new DevkitError("INVALID_PRIVATE_CODEX_STATE_ROOT");
      chmodSync(canonical, 0o700);
      if ((statSync(canonical).mode & 0o077) !== 0) throw new DevkitError("PRIVATE_CODEX_STATE_PERMISSIONS_UNSAFE");
      if (forbidden.some(root => overlaps(canonical, root))) throw new DevkitError("PRIVATE_CODEX_STATE_OVERLAPS_FORBIDDEN_ROOT");
      this.path = canonical;
    } catch (error) {
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("INVALID_PRIVATE_CODEX_STATE_ROOT");
    }
  }
}

export function createPrivateCodexStateRoot(options: PrivateCodexStateRootOptions): PrivateCodexStateRoot {
  return new PrivateCodexStateRoot(options);
}

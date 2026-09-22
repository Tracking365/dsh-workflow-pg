import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { byteHash, contextReference, DevkitError, hash, object, text, type FrozenContext, type FrozenContextFile } from "../contracts/task.js";
import { redact, resolveRealWithin } from "../domain/security.js";
import { git, gitBytes } from "./workspace.js";

export const MAX_CONTEXT_FILES = 8;
export const MAX_CONTEXT_FILE_BYTES = 4 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 6 * 1024;

export interface ContextContentFile extends FrozenContextFile { readonly content: string }
export interface LoadedContext { readonly manifest: FrozenContext; readonly files: readonly ContextContentFile[] }

function isSha(value: string): boolean {
  return /^[a-f0-9]{40,64}$/.test(value);
}

function isContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFiles(left: readonly FrozenContextFile[], right: readonly FrozenContextFile[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return other !== undefined && file.path === other.path && file.hash === other.hash && file.size === other.size;
  });
}

function manifestFor(baseCommit: string, files: readonly FrozenContextFile[]): FrozenContext {
  const normalized = files.map(file => ({ path: file.path, hash: file.hash, size: file.size }));
  return {
    schemaVersion: 1,
    baseCommit,
    manifestHash: hash({ schemaVersion: 1, baseCommit, files: normalized }),
    files: normalized,
  };
}

function checkedBaseCommit(value: unknown, field: string): string {
  const commit = text(value, field, 64);
  if (!isSha(commit)) throw new DevkitError("INVALID_CONTEXT_MANIFEST", field);
  return commit;
}

function checkedDescriptor(value: unknown, field: string): FrozenContextFile {
  const record = object(value, ["path", "hash", "size"]);
  const file = {
    path: contextReference(record.path, `${field}.path`),
    hash: text(record.hash, `${field}.hash`, 64),
    size: Number(record.size),
  };
  if (!isContentHash(file.hash) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_CONTEXT_FILE_BYTES) throw new DevkitError("INVALID_CONTEXT_MANIFEST", field);
  return file;
}

function checkedDescriptors(value: unknown): FrozenContextFile[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CONTEXT_FILES) throw new DevkitError("INVALID_CONTEXT_MANIFEST");
  const files = value.map((item, index) => checkedDescriptor(item, `context.files[${index}]`));
  const sorted = [...files].sort((left, right) => comparePaths(left.path, right.path));
  if (!sameFiles(files, sorted) || new Set(files.map(file => file.path)).size !== files.length || files.reduce((total, file) => total + file.size, 0) > MAX_CONTEXT_TOTAL_BYTES) {
    throw new DevkitError("INVALID_CONTEXT_MANIFEST");
  }
  return files;
}

function parseManifest(value: unknown): FrozenContext {
  const record = object(value, ["schemaVersion", "baseCommit", "manifestHash", "files"]);
  if (record.schemaVersion !== 1) throw new DevkitError("INVALID_CONTEXT_MANIFEST");
  const baseCommit = checkedBaseCommit(record.baseCommit, "context.baseCommit");
  const files = checkedDescriptors(record.files);
  const manifestHash = text(record.manifestHash, "context.manifestHash", 64);
  const expected = manifestFor(baseCommit, files);
  if (!isContentHash(manifestHash) || manifestHash !== expected.manifestHash) throw new DevkitError("INVALID_CONTEXT_MANIFEST");
  return expected;
}

function decodeContext(bytes: Buffer, reference: string): string {
  if (bytes.length < 1 || bytes.length > MAX_CONTEXT_FILE_BYTES) throw new DevkitError("CONTEXT_FILE_SIZE_LIMIT", reference);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DevkitError("CONTEXT_FILE_NOT_UTF8", reference); }
  if (content.includes("\0")) throw new DevkitError("CONTEXT_FILE_NOT_TEXT", reference);
  if (redact(content) !== content) throw new DevkitError("POSSIBLE_SECRET_IN_CONTEXT", reference);
  return content;
}

function parseStored(value: unknown): LoadedContext {
  const record = object(value, ["schemaVersion", "baseCommit", "manifestHash", "files"]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.files)) throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT");
  const files: ContextContentFile[] = record.files.map((value, index) => {
    const file = object(value, ["path", "hash", "size", "content"]);
    const descriptor = checkedDescriptor({ path: file.path, hash: file.hash, size: file.size }, `context.files[${index}]`);
    if (typeof file.content !== "string" || file.content.includes("\0")) throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT");
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.length !== descriptor.size || byteHash(bytes) !== descriptor.hash || redact(file.content) !== file.content) throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT");
    return { ...descriptor, content: file.content };
  });
  const manifest = parseManifest({
    schemaVersion: record.schemaVersion,
    baseCommit: record.baseCommit,
    manifestHash: record.manifestHash,
    files: files.map(({ path, hash, size }) => ({ path, hash, size })),
  });
  if (!sameFiles(manifest.files, files)) throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT");
  return { manifest, files };
}

function allowed(reference: string, rules: readonly string[]): boolean {
  return rules.some(rule => rule.endsWith("/") ? reference.startsWith(rule) : reference === rule);
}

function normalizedReferences(references: readonly string[]): string[] {
  if (!references.length || references.length > MAX_CONTEXT_FILES) throw new DevkitError("INVALID_CONTEXT_REFERENCES");
  const result = references.map((reference, index) => contextReference(reference, `contextRefs[${index}]`)).sort(comparePaths);
  if (new Set(result).size !== result.length) throw new DevkitError("DUPLICATE_CONTEXT_REFERENCE");
  return result;
}

function normalizedRules(rules: readonly string[]): string[] {
  if (!rules.length || rules.length > 20) throw new DevkitError("CONTEXT_REFERENCE_NOT_AUTHORIZED");
  const result = rules.map((rule, index) => contextReference(rule, `contextPaths[${index}]`, true)).sort(comparePaths);
  if (new Set(result).size !== result.length) throw new DevkitError("INVALID_CONTEXT_POLICY");
  return result;
}

/**
 * Persists only host-authorized, immutable Git-base context. The task record
 * keeps the small manifest; raw text remains in a private data-root artifact
 * and is revalidated before it is given to an executor.
 */
export class ContextStore {
  private readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new DevkitError("CONTEXT_ROOT_SYMLINK");
    chmodSync(root, 0o700);
    this.root = realpathSync(root);
  }

  freeze(repository: string, baseCommit: string, references: readonly string[], rules: readonly string[]): FrozenContext {
    if (!isSha(baseCommit)) throw new DevkitError("INVALID_BASE_COMMIT");
    const authorizedRules = normalizedRules(rules);
    const files: ContextContentFile[] = [];
    let total = 0;
    for (const reference of normalizedReferences(references)) {
      if (!allowed(reference, authorizedRules)) throw new DevkitError("CONTEXT_REFERENCE_NOT_AUTHORIZED", reference);
      const objectName = `${baseCommit}:${reference}`;
      let kind: string;
      try { kind = git(repository, ["cat-file", "-t", objectName]).trim(); }
      catch { throw new DevkitError("CONTEXT_REFERENCE_MISSING", reference); }
      if (kind !== "blob") throw new DevkitError("CONTEXT_REFERENCE_NOT_FILE", reference);
      let bytes: Buffer;
      try { bytes = gitBytes(repository, ["show", "--no-textconv", objectName]); }
      catch { throw new DevkitError("CONTEXT_REFERENCE_UNAVAILABLE", reference); }
      const content = decodeContext(bytes, reference);
      total += bytes.length;
      if (total > MAX_CONTEXT_TOTAL_BYTES) throw new DevkitError("CONTEXT_SIZE_LIMIT");
      files.push({ path: reference, hash: byteHash(bytes), size: bytes.length, content });
    }
    const manifest = manifestFor(baseCommit, files);
    this.persist({ manifest, files });
    return manifest;
  }

  load(expectedValue: FrozenContext): LoadedContext {
    const expected = parseManifest(expectedValue);
    const target = this.target(expected.manifestHash);
    let parsed: LoadedContext;
    try { parsed = parseStored(JSON.parse(readFileSync(target, "utf8")) as unknown); }
    catch { throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT"); }
    if (parsed.manifest.baseCommit !== expected.baseCommit || parsed.manifest.manifestHash !== expected.manifestHash || !sameFiles(parsed.manifest.files, expected.files)) {
      throw new DevkitError("CONTEXT_ARTIFACT_MISMATCH");
    }
    return parsed;
  }

  assertWorkspace(context: LoadedContext, workspace: string): void {
    for (const file of context.files) {
      let candidate: string;
      try {
        candidate = resolveRealWithin(workspace, file.path);
        if (!lstatSync(candidate).isFile()) throw new DevkitError("CONTEXT_WORKSPACE_MISMATCH", file.path);
      } catch (error) {
        if (error instanceof DevkitError) throw error;
        throw new DevkitError("CONTEXT_WORKSPACE_MISMATCH", file.path);
      }
      let bytes: Buffer;
      try { bytes = readFileSync(candidate); }
      catch { throw new DevkitError("CONTEXT_WORKSPACE_MISMATCH", file.path); }
      if (bytes.length !== file.size || byteHash(bytes) !== file.hash) throw new DevkitError("CONTEXT_WORKSPACE_MISMATCH", file.path);
    }
  }

  private persist(context: LoadedContext): void {
    const target = this.target(context.manifest.manifestHash);
    const serialized = JSON.stringify({
      schemaVersion: 1,
      baseCommit: context.manifest.baseCommit,
      manifestHash: context.manifest.manifestHash,
      files: context.files,
    });
    if (!existsSync(target)) {
      try { writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new DevkitError("CONTEXT_ARTIFACT_WRITE_FAILED");
      }
    }
    try {
      if (!lstatSync(target).isFile()) throw new DevkitError("CONTEXT_ARTIFACT_CORRUPT");
      chmodSync(target, 0o600);
    } catch (error) {
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("CONTEXT_ARTIFACT_WRITE_FAILED");
    }
    const persisted = this.load(context.manifest);
    if (!sameFiles(persisted.manifest.files, context.manifest.files)) throw new DevkitError("CONTEXT_ARTIFACT_MISMATCH");
  }

  private target(manifestHash: string): string {
    if (!isContentHash(manifestHash)) throw new DevkitError("INVALID_CONTEXT_MANIFEST");
    return resolveRealWithin(this.root, `${manifestHash}.json`);
  }
}

export function createContextStore(root: string): ContextStore {
  return new ContextStore(path.resolve(root));
}

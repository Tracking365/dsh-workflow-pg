import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { byteHash, DevkitError, hash, object, regressionOverlayReference, regressionOverlayTarget, text, type FrozenRegressionOverlay, type FrozenRegressionOverlayFile } from "../contracts/task.js";
import { redact, resolveRealWithin } from "../domain/security.js";
import { git } from "./workspace.js";

export const MAX_REGRESSION_OVERLAY_FILES = 8;
export const MAX_REGRESSION_OVERLAY_FILE_BYTES = 16 * 1024;
export const MAX_REGRESSION_OVERLAY_TOTAL_BYTES = 48 * 1024;

export interface RegressionOverlayContentFile extends FrozenRegressionOverlayFile {
  readonly baselineFailureMarker: string;
  readonly content: string;
}
export interface LoadedRegressionOverlay {
  readonly manifest: FrozenRegressionOverlay;
  readonly files: readonly RegressionOverlayContentFile[];
}
export interface RegressionOverlayDefinition {
  readonly source: string;
  readonly target: string;
  readonly verificationProfile: string;
  readonly baselineFailureMarker: string;
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{40,64}$/.test(value);
}

function isContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function compareReferences(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFiles(left: readonly FrozenRegressionOverlayFile[], right: readonly FrozenRegressionOverlayFile[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return other !== undefined
      && file.ref === other.ref
      && file.target === other.target
      && file.hash === other.hash
      && file.size === other.size
      && file.baselineFailureMarkerHash === other.baselineFailureMarkerHash;
  });
}

function manifestFor(baseCommit: string, files: readonly FrozenRegressionOverlayFile[]): FrozenRegressionOverlay {
  const normalized = files.map(file => ({
    ref: file.ref,
    target: file.target,
    hash: file.hash,
    size: file.size,
    baselineFailureMarkerHash: file.baselineFailureMarkerHash,
  }));
  return {
    schemaVersion: 1,
    baseCommit,
    manifestHash: hash({ schemaVersion: 1, baseCommit, files: normalized }),
    files: normalized,
  };
}

function checkedBaseCommit(value: unknown): string {
  const commit = text(value, "regressionOverlay.baseCommit", 64);
  if (!isSha(commit)) throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
  return commit;
}

function checkedDescriptor(value: unknown, field: string): FrozenRegressionOverlayFile {
  const record = object(value, ["ref", "target", "hash", "size", "baselineFailureMarkerHash"]);
  const file = {
    ref: regressionOverlayReference(record.ref, `${field}.ref`),
    target: regressionOverlayTarget(record.target, `${field}.target`),
    hash: text(record.hash, `${field}.hash`, 64),
    size: Number(record.size),
    baselineFailureMarkerHash: text(record.baselineFailureMarkerHash, `${field}.baselineFailureMarkerHash`, 64),
  };
  if (!isContentHash(file.hash) || !isContentHash(file.baselineFailureMarkerHash) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_REGRESSION_OVERLAY_FILE_BYTES) {
    throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST", field);
  }
  return file;
}

function checkedDescriptors(value: unknown): FrozenRegressionOverlayFile[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REGRESSION_OVERLAY_FILES) throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
  const files = value.map((item, index) => checkedDescriptor(item, `regressionOverlay.files[${index}]`));
  const sorted = [...files].sort((left, right) => compareReferences(left.ref, right.ref));
  if (!sameFiles(files, sorted)
    || new Set(files.map(file => file.ref)).size !== files.length
    || new Set(files.map(file => file.target)).size !== files.length
    || files.reduce((total, file) => total + file.size, 0) > MAX_REGRESSION_OVERLAY_TOTAL_BYTES) {
    throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
  }
  return files;
}

function parseManifest(value: unknown): FrozenRegressionOverlay {
  const record = object(value, ["schemaVersion", "baseCommit", "manifestHash", "files"]);
  if (record.schemaVersion !== 1) throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
  const baseCommit = checkedBaseCommit(record.baseCommit);
  const files = checkedDescriptors(record.files);
  const manifestHash = text(record.manifestHash, "regressionOverlay.manifestHash", 64);
  const expected = manifestFor(baseCommit, files);
  if (!isContentHash(manifestHash) || manifestHash !== expected.manifestHash) throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
  return expected;
}

function decodeOverlay(bytes: Buffer, reference: string): string {
  if (bytes.length < 1 || bytes.length > MAX_REGRESSION_OVERLAY_FILE_BYTES) throw new DevkitError("REGRESSION_OVERLAY_FILE_SIZE_LIMIT", reference);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DevkitError("REGRESSION_OVERLAY_FILE_NOT_UTF8", reference); }
  if (content.includes("\0")) throw new DevkitError("REGRESSION_OVERLAY_FILE_NOT_TEXT", reference);
  if (redact(content) !== content) throw new DevkitError("POSSIBLE_SECRET_IN_REGRESSION_OVERLAY", reference);
  return content;
}

function parseStored(value: unknown): LoadedRegressionOverlay {
  const record = object(value, ["schemaVersion", "baseCommit", "manifestHash", "files"]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.files)) throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
  const files: RegressionOverlayContentFile[] = record.files.map((value, index) => {
    const file = object(value, ["ref", "target", "hash", "size", "baselineFailureMarkerHash", "baselineFailureMarker", "content"]);
    const descriptor = checkedDescriptor({
      ref: file.ref,
      target: file.target,
      hash: file.hash,
      size: file.size,
      baselineFailureMarkerHash: file.baselineFailureMarkerHash,
    }, `regressionOverlay.files[${index}]`);
    if (typeof file.content !== "string" || file.content.includes("\0")) throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
    let marker: string;
    try { marker = text(file.baselineFailureMarker, `regressionOverlay.files[${index}].baselineFailureMarker`, 512); }
    catch { throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT"); }
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.length !== descriptor.size
      || byteHash(bytes) !== descriptor.hash
      || byteHash(marker) !== descriptor.baselineFailureMarkerHash
      || redact(file.content) !== file.content
      || redact(marker) !== marker) {
      throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
    }
    return { ...descriptor, baselineFailureMarker: marker, content: file.content };
  });
  const manifest = parseManifest({
    schemaVersion: record.schemaVersion,
    baseCommit: record.baseCommit,
    manifestHash: record.manifestHash,
    files: files.map(({ ref, target, hash, size, baselineFailureMarkerHash }) => ({ ref, target, hash, size, baselineFailureMarkerHash })),
  });
  if (!sameFiles(manifest.files, files)) throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
  return { manifest, files };
}

function normalizedReferences(references: readonly string[]): string[] {
  if (!references.length || references.length > MAX_REGRESSION_OVERLAY_FILES) throw new DevkitError("INVALID_REGRESSION_OVERLAY_REFERENCES");
  const result = references.map((reference, index) => regressionOverlayReference(reference, `regressionOverlayRefs[${index}]`)).sort(compareReferences);
  if (new Set(result).size !== result.length) throw new DevkitError("DUPLICATE_REGRESSION_OVERLAY_REFERENCE");
  return result;
}

function readSource(source: string, reference: string): Buffer {
  try {
    const resolved = path.resolve(source);
    const canonical = realpathSync(resolved);
    const sourceStat = lstatSync(resolved);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || !lstatSync(canonical).isFile()) throw new DevkitError("REGRESSION_OVERLAY_SOURCE_UNAVAILABLE", reference);
    return readFileSync(canonical);
  } catch (error) {
    if (error instanceof DevkitError) throw error;
    throw new DevkitError("REGRESSION_OVERLAY_SOURCE_UNAVAILABLE", reference);
  }
}

function assertTargetAbsent(repository: string, baseCommit: string, target: string): void {
  let listed: string;
  try { listed = git(repository, ["ls-tree", "-r", "--name-only", baseCommit, "--", target]); }
  catch { throw new DevkitError("REGRESSION_OVERLAY_TARGET_UNAVAILABLE", target); }
  if (listed.split("\n").filter(Boolean).includes(target)) throw new DevkitError("REGRESSION_OVERLAY_TARGET_EXISTS", target);
}

/**
 * Freezes host-owned regression-test sources at task creation. Task records
 * retain descriptors only; runtime reloads and checks private bytes before
 * they are written once into a fresh candidate clone.
 */
export class RegressionOverlayStore {
  private readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new DevkitError("REGRESSION_OVERLAY_ROOT_SYMLINK");
    chmodSync(root, 0o700);
    this.root = realpathSync(root);
  }

  freeze(
    repository: string,
    baseCommit: string,
    references: readonly string[],
    definitions: Readonly<Record<string, RegressionOverlayDefinition>>,
    verificationProfile: string,
  ): FrozenRegressionOverlay {
    if (!isSha(baseCommit)) throw new DevkitError("INVALID_BASE_COMMIT");
    const files: RegressionOverlayContentFile[] = [];
    let total = 0;
    for (const reference of normalizedReferences(references)) {
      const definition = definitions[reference];
      if (definition === undefined) throw new DevkitError("REGRESSION_OVERLAY_NOT_AUTHORIZED", reference);
      if (definition.verificationProfile !== verificationProfile) throw new DevkitError("REGRESSION_OVERLAY_PROFILE_MISMATCH", reference);
      const marker = text(definition.baselineFailureMarker, `regressionOverlays.${reference}.baselineFailureMarker`, 512);
      if (redact(marker) !== marker) throw new DevkitError("INVALID_REGRESSION_OVERLAY_POLICY", reference);
      assertTargetAbsent(repository, baseCommit, definition.target);
      const bytes = readSource(definition.source, reference);
      const content = decodeOverlay(bytes, reference);
      total += bytes.length;
      if (total > MAX_REGRESSION_OVERLAY_TOTAL_BYTES) throw new DevkitError("REGRESSION_OVERLAY_SIZE_LIMIT");
      files.push({
        ref: reference,
        target: definition.target,
        hash: byteHash(bytes),
        size: bytes.length,
        baselineFailureMarkerHash: byteHash(marker),
        baselineFailureMarker: marker,
        content,
      });
    }
    const manifest = manifestFor(baseCommit, files);
    this.persist({ manifest, files });
    return manifest;
  }

  load(expectedValue: FrozenRegressionOverlay): LoadedRegressionOverlay {
    const expected = parseManifest(expectedValue);
    const target = this.target(expected.manifestHash);
    let parsed: LoadedRegressionOverlay;
    try { parsed = parseStored(JSON.parse(readFileSync(target, "utf8")) as unknown); }
    catch { throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT"); }
    if (parsed.manifest.baseCommit !== expected.baseCommit || parsed.manifest.manifestHash !== expected.manifestHash || !sameFiles(parsed.manifest.files, expected.files)) {
      throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_MISMATCH");
    }
    return parsed;
  }

  apply(overlay: LoadedRegressionOverlay, workspace: string): void {
    for (const file of overlay.files) {
      try {
        let target = resolveRealWithin(workspace, file.target);
        if (existsSync(target)) throw new DevkitError("REGRESSION_OVERLAY_TARGET_EXISTS", file.target);
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        target = resolveRealWithin(workspace, file.target);
        if (existsSync(target)) throw new DevkitError("REGRESSION_OVERLAY_TARGET_EXISTS", file.target);
        writeFileSync(target, Buffer.from(file.content, "utf8"), { flag: "wx", mode: 0o600 });
        if (!lstatSync(target).isFile()) throw new DevkitError("REGRESSION_OVERLAY_WORKSPACE_MISMATCH", file.target);
      } catch (error) {
        if (error instanceof DevkitError) throw error;
        throw new DevkitError("REGRESSION_OVERLAY_APPLY_FAILED", file.target);
      }
    }
    this.assertWorkspace(overlay, workspace);
  }

  assertWorkspace(overlay: LoadedRegressionOverlay, workspace: string): void {
    for (const file of overlay.files) {
      let candidate: string;
      try {
        candidate = resolveRealWithin(workspace, file.target);
        if (!lstatSync(candidate).isFile()) throw new DevkitError("REGRESSION_OVERLAY_WORKSPACE_MISMATCH", file.target);
      } catch (error) {
        if (error instanceof DevkitError) throw error;
        throw new DevkitError("REGRESSION_OVERLAY_WORKSPACE_MISMATCH", file.target);
      }
      let bytes: Buffer;
      try { bytes = readFileSync(candidate); }
      catch { throw new DevkitError("REGRESSION_OVERLAY_WORKSPACE_MISMATCH", file.target); }
      if (bytes.length !== file.size || byteHash(bytes) !== file.hash) throw new DevkitError("REGRESSION_OVERLAY_WORKSPACE_MISMATCH", file.target);
    }
  }

  private persist(overlay: LoadedRegressionOverlay): void {
    const target = this.target(overlay.manifest.manifestHash);
    const serialized = JSON.stringify({
      schemaVersion: 1,
      baseCommit: overlay.manifest.baseCommit,
      manifestHash: overlay.manifest.manifestHash,
      files: overlay.files,
    });
    if (!existsSync(target)) {
      try { writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_WRITE_FAILED");
      }
    }
    try {
      if (!lstatSync(target).isFile()) throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_CORRUPT");
      chmodSync(target, 0o600);
    } catch (error) {
      if (error instanceof DevkitError) throw error;
      throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_WRITE_FAILED");
    }
    const persisted = this.load(overlay.manifest);
    if (!sameFiles(persisted.manifest.files, overlay.manifest.files)) throw new DevkitError("REGRESSION_OVERLAY_ARTIFACT_MISMATCH");
  }

  private target(manifestHash: string): string {
    if (!isContentHash(manifestHash)) throw new DevkitError("INVALID_REGRESSION_OVERLAY_MANIFEST");
    return resolveRealWithin(this.root, `${manifestHash}.json`);
  }
}

export function createRegressionOverlayStore(root: string): RegressionOverlayStore {
  return new RegressionOverlayStore(path.resolve(root));
}

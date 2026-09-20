import path from "node:path";

export function resolveWithin(root: string, candidate: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
  throw new Error("PATH_OUTSIDE_ALLOWED_ROOT");
}

export function rejectModelAuthority(input: Record<string, unknown>): void {
  for (const key of ["approved", "readyForAcceptance", "executionMode", "workspaceRoot"]) if (key in input) throw new Error(`MODEL_CANNOT_SET_${key.toUpperCase()}`);
}

// Artifact-content and import smoke test only; NOT a native DSH runtime test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(path.join(os.tmpdir(), "devkit-pack-"));
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { encoding: "utf8" }));
const archive = path.join(dir, packed[0].filename);
execFileSync("tar", ["-xzf", archive, "-C", dir]);
const root = path.join(dir, "package");
for (const file of ["native/index.mjs", "dist/src/index.js", "dist/src/contracts/policy.js", "cordis.patch.yml", "skills/bugfix/SKILL.md", "docs/SECURITY.md"]) assert.ok(existsSync(path.join(root, file)), file);
assert.equal(existsSync(path.join(root, "dist/tests")), false);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
const native = await import(pathToFileURL(path.join(root, "native/index.mjs")).href);
assert.deepEqual(native.inject, ["tools"]); assert.equal(typeof native.apply, "function");
const core = await import(pathToFileURL(path.join(root, "dist/src/index.js")).href);
const runtime = new core.Devkit({ dataRoot: path.join(dir, "data"), executionMode: "disabled", repositories: {}, verificationProfiles: {}, maxRetries: 2, maxDurationMs: 1000 });
try {
  const defs = native.toolDefinitions(runtime);
  assert.equal(defs.length, 7); assert.equal(new Set(defs.map(d => d.name)).size, 7);
  for (const def of defs) { assert.equal(def.parameters.additionalProperties, false); assert.equal(typeof def.output.render, "function"); }
  const doctor = defs.find(d => d.name === "devkit_doctor");
  const result = await doctor.execute({}, { signal: new AbortController().signal });
  assert.equal(result.live.state, "unsupported");
  await assert.rejects(doctor.execute({ approved: true }, { signal: new AbortController().signal }));
  assert.equal(defs.some(d => /accept|approve/.test(d.name)), false);
} finally { await runtime.close(); }
console.log(JSON.stringify({ status: "passed", layer: "package-import-contract-only", nativeDshRuntime: "not-executed", archive }, null, 2));

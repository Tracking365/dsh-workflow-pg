import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MacosSeatbeltCommandConfinement, probeMacosSeatbelt, runCommand } from "../../dist/src/index.js";

test("macOS Seatbelt capability probe reports real enforcement or a fail-closed host limitation", async () => {
  const capability = await probeMacosSeatbelt();
  assert.equal(capability.mechanism, "macos-seatbelt");
  if (capability.state === "supported") {
    assert.equal(capability.platform, "darwin");
    assert.equal(capability.enforcement, "full");
    assert.equal(capability.filesystem, "full");
    assert.equal(capability.network, "full");
    assert.equal(capability.credentialReads, "configured-roots");
    assert.deepEqual(capability.probe, {
      workspaceWriteAllowed: true,
      controlWriteDenied: true,
      protectedReadDenied: true,
      networkDenied: true,
    });
  } else {
    assert.equal(capability.enforcement, "none");
    assert.equal(capability.filesystem, "none");
    assert.equal(capability.network, "none");
    assert.equal(capability.credentialReads, "none");
    assert.match(capability.reason, /SEATBELT|SANDBOX_EXEC|MACOS/);
  }
  if (process.env.DSH_DEVKIT_REQUIRE_SEATBELT === "1") assert.equal(capability.state, "supported", capability.state === "unsupported" ? capability.reason : "");
});

test("runCommand uses Seatbelt rather than falling back to an unrestricted command", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-command-host-"));
  const workspace = path.join(root, "workspace");
  const control = path.join(root, "control");
  const protectedRoot = path.join(root, "protected");
  const expectedSupported = process.env.DSH_DEVKIT_REQUIRE_SEATBELT === "1";
  try {
    for (const directory of [workspace, control, protectedRoot]) mkdirSync(directory, { mode: 0o700 });
    const protectedFile = path.join(protectedRoot, "credential.txt");
    writeFileSync(protectedFile, "synthetic-credential", { mode: 0o600 });
    const confinement = new MacosSeatbeltCommandConfinement({ deniedReadRoots: [protectedRoot] });
    const capability = await confinement.status();
    if (capability.state === "unsupported") {
      await assert.rejects(confinement.prepare([process.execPath, "--version"], workspace, new AbortController().signal), /SANDBOX_UNAVAILABLE/);
      assert.equal(expectedSupported, false, capability.reason);
      return;
    }
    writeFileSync(path.join(workspace, "seatbelt.mjs"), [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import test from 'node:test';",
      "test('confined command',()=>{",
      "  fs.writeFileSync(path.join(process.cwd(),'allowed.txt'),'allowed');",
      `  assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(control, "forbidden.txt"))},'forbidden'));`,
      `  assert.throws(()=>fs.readFileSync(${JSON.stringify(protectedFile)},'utf8'));`,
      "});",
      "",
    ].join("\n"));
    const result = await runCommand({
      id: "seatbelt-host", command: process.execPath, args: ["--test", "--test-reporter=tap", "seatbelt.mjs"], criteria: ["A1"], timeoutMs: 5000,
    }, workspace, new AbortController().signal, confinement);
    assert.equal(result.classification, "passed", `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
  }
});

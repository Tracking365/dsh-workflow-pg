// Explicit, slow integration gate. It boots an isolated official DSH headless
// profile but deliberately supplies no task, credentials, or model request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const profile = "devkit-launcher-fixture";
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-launcher-"));
const packDir = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-pack-"));
const policyPath = path.join(home, "devkit-policy.json");
const dshEntry = path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

assert.ok(existsSync(dshEntry), "Install @deepseek-ai/dsh before running this launcher gate.");

const environment = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: "1",
  DSH_DEVKIT_CONFIG: policyPath,
};

function run(command, args, { timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${output}`);
  return { stdout: result.stdout ?? "", output };
}

function dsh(args, options) {
  return run(process.execPath, [dshEntry, ...args], options).output;
}

// Initialize a disposable profile first, so the plugin add cannot affect a
// user's normal DSH home or an installed profile.
dsh(["--profile", profile, "--from-default-profile", "headless", "--dump-config"]);

const packed = JSON.parse(run(npmCommand, ["pack", "--json", "--pack-destination", packDir]).stdout);
const archive = path.join(packDir, packed[0].filename);
dsh(["plugin", "--profile", profile, "add", archive], { timeout: 300_000 });

const config = dsh(["--profile", profile, "--dump-config"]);
assert.match(config, /# == dsh-devkit/);
assert.match(config, /\bid: devkit\b/);

writeFileSync(policyPath, JSON.stringify({
  dataRoot: path.join(home, "devkit-data"),
  executionMode: "disabled",
  repositories: {},
  verificationProfiles: {},
  maxRetries: 2,
  maxDurationMs: 10_000,
}, null, 2));

for (let launch = 1; launch <= 2; launch += 1) {
  const help = dsh(["--profile", profile, "--help"]);
  assert.match(help, /Usage: dsh --profile headless/);
  assert.ok(existsSync(path.join(home, "devkit-data", "tasks.sqlite")), `launcher boot ${launch} did not mount DevKit`);
}

console.log(JSON.stringify({
  status: "passed",
  layer: "official-dsh-launcher-profile",
  profile,
  modelTaskProvided: false,
  telemetryDisabled: true,
  archive,
  home,
}, null, 2));

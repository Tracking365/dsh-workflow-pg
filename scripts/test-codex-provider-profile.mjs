// Explicit, slow integration gate for the published Codex provider bundle.
// It only installs and boots a disposable DSH profile; no task, credential
// probe, or Codex App Server process is requested.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const profile = "codex-provider-registration-fixture";
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-codex-provider-profile-"));
const packDir = mkdtempSync(path.join(os.tmpdir(), "dsh-codex-provider-pack-"));
const dshEntry = path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const providerDir = path.join(root, "node_modules", "@deepseek-ai", "dsh-subagent-codex");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

assert.ok(existsSync(dshEntry), "Install @deepseek-ai/dsh before running this provider-profile gate.");
assert.ok(existsSync(providerDir), "Install @deepseek-ai/dsh-subagent-codex before running this provider-profile gate.");

const environment = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: "1",
  // Do not depend on or repair a user's shared npm cache while packing the
  // already-installed local provider for this disposable profile.
  NPM_CONFIG_CACHE: path.join(home, "npm-cache"),
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

// Work in a disposable headless profile so that the test can never mutate a
// user's normal DSH home or profile. Loading this bundle only registers the
// provider; the official provider starts Codex after a later subagent request.
dsh(["--profile", profile, "--from-default-profile", "headless", "--dump-config"]);

const packed = JSON.parse(run(npmCommand, ["pack", providerDir, "--json", "--pack-destination", packDir]).stdout);
assert.equal(packed.length, 1, "Expected exactly one Codex provider tarball.");
const archive = path.join(packDir, packed[0].filename);
dsh(["plugin", "--profile", profile, "add", archive], { timeout: 300_000 });

const config = dsh(["--profile", profile, "--dump-config"]);
assert.match(config, /# == @deepseek-ai\/dsh-subagent-codex/);
assert.match(config, /\bid: subagent-codex\b/);

for (let launch = 1; launch <= 2; launch += 1) {
  const help = dsh(["--profile", profile, "--help"]);
  assert.match(help, /Usage: dsh --profile headless/);
}

console.log(JSON.stringify({
  status: "passed",
  layer: "official-dsh-codex-provider-profile",
  profile,
  modelTaskProvided: false,
  telemetryDisabled: true,
  archive,
  home,
}, null, 2));

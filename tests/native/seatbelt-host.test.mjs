import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MacosSeatbeltAppServerConfinement, MacosSeatbeltCommandConfinement, MacosSeatbeltManagedAuthLaunch, PrivateCodexStateRoot, probeMacosSeatbelt, runCommand } from "../../dist/src/index.js";

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback fixture did not receive a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function listenUnix(server, socket) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * The App Server provider consumes a synchronous DSH subprocess service. This
 * local implementation intentionally starts only the test's fake package
 * wrapper; it contains no Codex binary, account state, or model transport.
 */
function localSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: [spec.stdio.stdin, spec.stdio.stdout, spec.stdio.stderr],
      });
      let exited = false;
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          exited = true;
          resolve({ exitCode, signal });
        });
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        control: undefined,
        collected: {},
        done,
        terminate() { child.kill("SIGTERM"); },
        async waitForExit() {
          await done;
          return exited;
        },
      };
    },
  };
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { value += chunk; });
    stream.once("error", reject);
    stream.once("end", () => resolve(value));
  });
}

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
      unixSocketDenied: true,
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

test("the App Server boundary actually confines a Codex-shaped child without launching Codex", { timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-app-server-host-"));
  const workspace = path.join(root, "workspace");
  const control = path.join(root, "control");
  const protectedRoot = path.join(root, "protected");
  const packageBin = path.join(root, "fake-package", "node_modules", "@openai", "codex", "bin");
  const wrapper = path.join(packageBin, "codex.js");
  const unixRoot = mkdtempSync("/tmp/dshdk-app-server-");
  const inheritedName = "DEVKIT_APP_SERVER_PARENT_INJECTION_TEST";
  const hostHome = os.homedir();
  const hostTemporaryRoot = path.dirname(os.tmpdir());
  const priorInherited = process.env[inheritedName];
  process.env[inheritedName] = "must-not-reach-app-server";
  const expectedSupported = process.env.DSH_DEVKIT_REQUIRE_SEATBELT === "1";
  const server = createServer();
  const unixServer = createServer();
  let connections = 0;
  let unixConnections = 0;
  server.on("connection", (socket) => { connections += 1; socket.destroy(); });
  unixServer.on("connection", (socket) => { unixConnections += 1; socket.destroy(); });
  try {
    for (const directory of [workspace, control, protectedRoot, packageBin]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const protectedFile = path.join(protectedRoot, "credential.txt");
    writeFileSync(protectedFile, "synthetic-credential", { mode: 0o600 });
    let port;
    const unixSocket = path.join(unixRoot, "broker.sock");
    try {
      port = await listenLoopback(server);
      await listenUnix(unixServer, unixSocket);
    } catch (error) {
      assert.equal(expectedSupported, false, `host cannot prepare the local connectivity probe: ${String(error)}`);
      return;
    }
    writeFileSync(wrapper, [
      "import fs from 'node:fs';",
      "import net from 'node:net';",
      "import path from 'node:path';",
      `const result = { argv: process.argv.slice(2), parentInjectionAbsent: process.env.${inheritedName} === undefined, proxyEnvironmentAbsent: [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.NO_PROXY, process.env.ALL_PROXY, process.env.NODE_USE_ENV_PROXY].every((value) => value === undefined), codeHomeAbsent: process.env.CODEX_HOME === undefined, privateHome: process.env.HOME };`,
      "try { fs.writeFileSync(path.join(process.cwd(), 'app-server-allowed.txt'), 'allowed'); result.workspaceWriteAllowed = true; } catch { result.workspaceWriteAllowed = false; }",
      `try { fs.writeFileSync(${JSON.stringify(path.join(control, "forbidden.txt"))}, 'forbidden'); result.controlWriteDenied = false; } catch { result.controlWriteDenied = true; }`,
      `try { fs.readFileSync(${JSON.stringify(protectedFile)}, 'utf8'); result.protectedReadDenied = false; } catch { result.protectedReadDenied = true; }`,
      `try { fs.readdirSync(${JSON.stringify(hostHome)}); result.hostHomeListingDenied = false; } catch { result.hostHomeListingDenied = true; }`,
      `try { fs.readdirSync(${JSON.stringify(hostTemporaryRoot)}); result.hostTemporaryListingDenied = false; } catch { result.hostTemporaryListingDenied = true; }`,
      "result.networkDenied = await new Promise((resolve) => {",
      `  const socket = net.createConnection({ host: '127.0.0.1', port: ${JSON.stringify(port)} });`,
      "  const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1500);",
      "  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });",
      "  socket.on('error', () => { clearTimeout(timer); resolve(true); });",
      "});",
      "result.unixSocketDenied = await new Promise((resolve) => {",
      `  const socket = net.createConnection({ path: ${JSON.stringify(unixSocket)} });`,
      "  const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1500);",
      "  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });",
      "  socket.on('error', () => { clearTimeout(timer); resolve(true); });",
      "});",
      "console.log(JSON.stringify(result));",
      "",
    ].join("\n"), { mode: 0o700 });

    const raw = localSubprocess();
    const seen = [];
    const boundary = new MacosSeatbeltAppServerConfinement({
      subprocess: { spawn(spec) { seen.push(spec); return raw.spawn(spec); } },
      deniedReadRoots: [protectedRoot],
    });
    const capability = await boundary.status();
    if (capability.state === "unsupported") {
      await assert.rejects(boundary.prepare(workspace, new AbortController().signal), /SANDBOX_UNAVAILABLE/);
      assert.equal(expectedSupported, false, capability.reason);
      return;
    }

    const prepared = await boundary.prepare(workspace, new AbortController().signal);
    const child = boundary.spawn({
      argv: [process.execPath, wrapper, "app-server", "--stdio"],
      cwd: workspace,
      env: {},
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      graceMs: 3000,
    });
    assert.ok(child.stdout, "the confined fake child must have stdout");
    assert.ok(child.stderr, "the confined fake child must have stderr");
    const output = readStream(child.stdout);
    const errors = readStream(child.stderr);
    const [exit, stdout, stderr] = await Promise.all([child.done, output, errors]);
    assert.equal(exit.exitCode, 0, `${stdout}\n${stderr}`);
    assert.equal(await child.waitForExit(), true);
    const result = JSON.parse(stdout.trim());
    assert.deepEqual(result.argv, ["app-server", "--stdio"]);
    assert.equal(result.workspaceWriteAllowed, true);
    assert.equal(result.controlWriteDenied, true);
    assert.equal(result.protectedReadDenied, true);
    assert.equal(result.hostHomeListingDenied, true);
    assert.equal(result.hostTemporaryListingDenied, true);
    assert.equal(result.networkDenied, true);
    assert.equal(result.unixSocketDenied, true);
    assert.equal(result.parentInjectionAbsent, true);
    assert.equal(result.proxyEnvironmentAbsent, true);
    assert.equal(result.codeHomeAbsent, true);
    assert.equal(connections, 0, "the confined child must not reach the loopback server");
    assert.equal(unixConnections, 0, "the confined child must not reach a local broker socket");
    assert.equal(existsSync(path.join(control, "forbidden.txt")), false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].argv[0], "/usr/bin/sandbox-exec");
    assert.match(seen[0].argv[2], /\(deny network\*\)/);
    assert.match(seen[0].argv[2], /\(deny file-read\*/);
    assert.equal(existsSync(result.privateHome), true, "private boundary state remains until provider range proof");
    assert.equal(await prepared.release(true), true);
    assert.equal(existsSync(result.privateHome), false, "private boundary state is removed only after confirmed exit");
  } finally {
    if (priorInherited === undefined) delete process.env[inheritedName];
    else process.env[inheritedName] = priorInherited;
    await closeServer(server).catch(() => {});
    await closeServer(unixServer).catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
    rmSync(unixRoot, { recursive: true, force: true, maxRetries: 1 });
  }
});

test("the managed-auth launch preserves only private CODEX_HOME and still denies candidate/network access", { timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-devkit-seatbelt-managed-auth-host-"));
  const stateParent = path.join(root, "state-parent");
  const candidate = path.join(root, "candidate");
  const control = path.join(root, "control");
  const protectedRoot = path.join(root, "protected");
  const packageBin = path.join(root, "fake-package", "node_modules", "@openai", "codex", "bin");
  const wrapper = path.join(packageBin, "codex.js");
  const hostHome = os.homedir();
  const server = createServer();
  let connections = 0;
  server.on("connection", socket => { connections += 1; socket.destroy(); });
  const expectedSupported = process.env.DSH_DEVKIT_REQUIRE_SEATBELT === "1";
  try {
    for (const directory of [stateParent, candidate, control, protectedRoot, packageBin]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const protectedFile = path.join(protectedRoot, "credential.txt");
    writeFileSync(protectedFile, "synthetic-credential", { mode: 0o600 });
    let port;
    try {
      port = await listenLoopback(server);
    } catch (error) {
      assert.equal(expectedSupported, false, `host cannot prepare the local connectivity probe: ${String(error)}`);
      return;
    }
    writeFileSync(wrapper, [
      "import fs from 'node:fs';",
      "import net from 'node:net';",
      "import path from 'node:path';",
      `const result = { argv: process.argv.slice(2), cwd: process.cwd(), codexHome: process.env.CODEX_HOME, home: process.env.HOME };`,
      "try { fs.writeFileSync(path.join(process.env.CODEX_HOME, 'state-marker.txt'), 'managed'); result.stateWriteAllowed = true; } catch { result.stateWriteAllowed = false; }",
      `try { fs.readdirSync(${JSON.stringify(candidate)}); result.candidateReadDenied = false; } catch { result.candidateReadDenied = true; }`,
      `try { fs.writeFileSync(${JSON.stringify(path.join(control, "forbidden.txt"))}, 'forbidden'); result.controlWriteDenied = false; } catch { result.controlWriteDenied = true; }`,
      `try { fs.readFileSync(${JSON.stringify(protectedFile)}, 'utf8'); result.protectedReadDenied = false; } catch { result.protectedReadDenied = true; }`,
      `try { fs.readdirSync(${JSON.stringify(hostHome)}); result.hostHomeListingDenied = false; } catch { result.hostHomeListingDenied = true; }`,
      "result.networkDenied = await new Promise((resolve) => {",
      `  const socket = net.createConnection({ host: '127.0.0.1', port: ${JSON.stringify(port)} });`,
      "  const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1500);",
      "  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });",
      "  socket.on('error', () => { clearTimeout(timer); resolve(true); });",
      "});",
      "console.log(JSON.stringify(result));",
      "",
    ].join("\n"), { mode: 0o700 });
    const state = new PrivateCodexStateRoot({ root: path.join(stateParent, "auth"), forbiddenRoots: [candidate, control, protectedRoot] });
    const launch = new MacosSeatbeltManagedAuthLaunch({
      subprocess: localSubprocess(),
      wrapper,
      state,
      deniedReadRoots: [candidate, control, protectedRoot],
    });
    const capability = await launch.status();
    if (capability.state === "unsupported") {
      await assert.rejects(launch.prepare(new AbortController().signal), /SANDBOX_UNAVAILABLE/);
      assert.equal(expectedSupported, false, capability.reason);
      return;
    }
    const prepared = await launch.prepare(new AbortController().signal);
    assert.ok(prepared.child.stdout);
    assert.ok(prepared.child.stderr);
    const output = readStream(prepared.child.stdout);
    const errors = readStream(prepared.child.stderr);
    const [exit, stdout, stderr] = await Promise.all([prepared.child.done, output, errors]);
    assert.equal(exit.exitCode, 0, `${stdout}\n${stderr}`);
    assert.equal(await prepared.child.waitForExit(), true);
    const result = JSON.parse(stdout.trim());
    assert.deepEqual(result.argv, ["app-server", "--stdio"]);
    assert.equal(result.cwd, state.path);
    assert.equal(result.codexHome, state.path);
    assert.notEqual(result.home, state.path);
    assert.equal(result.stateWriteAllowed, true);
    assert.equal(result.candidateReadDenied, true);
    assert.equal(result.controlWriteDenied, true);
    assert.equal(result.protectedReadDenied, true);
    assert.equal(result.hostHomeListingDenied, true);
    assert.equal(result.networkDenied, true);
    assert.equal(connections, 0, "the managed-auth process must not reach a loopback service");
    assert.equal(existsSync(path.join(state.path, "state-marker.txt")), true);
    assert.equal(existsSync(result.home), true, "ephemeral HOME remains until managed child exit is proven");
    assert.equal(await prepared.release(true), true);
    assert.equal(existsSync(result.home), false);
    assert.equal(existsSync(path.join(state.path, "state-marker.txt")), true, "persistent state remains after session cleanup");
  } finally {
    await closeServer(server).catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 1 });
  }
});

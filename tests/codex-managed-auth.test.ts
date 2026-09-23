import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  CodexManagedAuthSession,
  DevkitError,
  type CodexManagedAuthLaunch,
} from "../src/index.js";

type Message = Record<string, unknown>;

class FakeManagedAuthAppServer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Message[] = [];
  readonly done: Promise<unknown>;
  readonly releaseCalls: boolean[] = [];
  terminateCalls = 0;
  private buffer = "";
  private finished = false;
  private complete!: (value: unknown) => void;

  constructor(
    private readonly onMessage: (message: Message, server: FakeManagedAuthAppServer) => void,
    private readonly exitConfirmed = true,
    private readonly releaseConfirmed = true,
  ) {
    this.done = new Promise(resolve => { this.complete = resolve; });
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Message;
        this.received.push(message);
        this.onMessage(message, this);
      }
    });
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stdout.end();
    this.stderr.end();
    this.complete({ exitCode: 0 });
  }

  launch(): CodexManagedAuthLaunch {
    return {
      id: "fake-private-managed-auth",
      purpose: "private-managed-chatgpt-oauth",
      prepare: async () => ({
        child: {
          stdin: this.stdin,
          stdout: this.stdout,
          stderr: this.stderr,
          control: undefined,
          collected: {},
          done: this.done,
          terminate: () => {
            this.terminateCalls += 1;
            this.finish();
          },
          waitForExit: async () => {
            if (!this.exitConfirmed) return false;
            await this.done;
            return true;
          },
        },
        release: async stopped => {
          this.releaseCalls.push(stopped);
          return this.releaseConfirmed;
        },
      }),
    };
  }
}

function id(message: Message): string | number {
  const value = message.id;
  assert.ok(typeof value === "string" || typeof value === "number");
  return value;
}

function protocolError(code: string): (error: unknown) => boolean {
  return error => error instanceof DevkitError && error.code === code;
}

test("private managed-auth session uses only the account protocol and verifies browser login", async () => {
  let authenticated = false;
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") {
      fake.send({ id: id(message), result: { platformFamily: "unix" } });
      return;
    }
    if (message.method === "account/read") {
      assert.deepEqual(message.params, { refreshToken: false });
      fake.send({ id: id(message), result: authenticated
        ? { account: { type: "chatgpt", email: "not-exposed@example.test", planType: "plus" }, requiresOpenaiAuth: true }
        : { account: null, requiresOpenaiAuth: true } });
      return;
    }
    if (message.method === "account/login/start") {
      assert.deepEqual(message.params, { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" });
      fake.send({ id: id(message), result: {
        type: "chatgpt",
        loginId: "11111111-1111-4111-8111-111111111111",
        authUrl: "https://chatgpt.com/auth/codex?state=opaque-test-state",
      } });
    }
  });

  const session = await CodexManagedAuthSession.open({ launch: server.launch() });
  assert.deepEqual(await session.status(), { state: "unauthenticated" });
  const challenge = await session.beginLogin("browser");
  assert.deepEqual(challenge, {
    type: "browser",
    loginId: "11111111-1111-4111-8111-111111111111",
    authUrl: "https://chatgpt.com/auth/codex?state=opaque-test-state",
  });

  authenticated = true;
  server.send({ method: "account/login/completed", params: {
    loginId: challenge.loginId,
    success: true,
    error: null,
  } });
  assert.deepEqual(await session.waitForLogin(challenge.loginId), { state: "authenticated" });

  const methods = server.received.map(message => message.method).filter((method): method is string => typeof method === "string");
  assert.deepEqual(methods, ["initialize", "initialized", "account/read", "account/read", "account/login/start", "account/read"]);
  assert.equal(methods.some(method => method.startsWith("thread/") || method.startsWith("turn/") || method === "account/logout"), false);
  assert.equal(JSON.stringify(server.received).includes("chatgptAuthTokens"), false);

  await session.close();
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
});

test("private managed-auth rejects non-ChatGPT accounts before a login can start", async () => {
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "account/read") fake.send({ id: id(message), result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
  });
  const session = await CodexManagedAuthSession.open({ launch: server.launch() });
  await assert.rejects(session.beginLogin("device-code"), protocolError("CODEX_MANAGED_AUTH_ACCOUNT_TYPE_REJECTED"));
  assert.equal(server.received.some(message => message.method === "account/login/start"), false);
  await session.close();
});

test("private managed-auth supports only managed device code and cancels the matching attempt", async () => {
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "account/read") fake.send({ id: id(message), result: { account: null, requiresOpenaiAuth: true } });
    else if (message.method === "account/login/start") {
      assert.deepEqual(message.params, { type: "chatgptDeviceCode" });
      fake.send({ id: id(message), result: {
        type: "chatgptDeviceCode",
        loginId: "22222222-2222-4222-8222-222222222222",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      } });
    } else if (message.method === "account/login/cancel") {
      assert.deepEqual(message.params, { loginId: "22222222-2222-4222-8222-222222222222" });
      fake.send({ id: id(message), result: {} });
    }
  });
  const session = await CodexManagedAuthSession.open({ launch: server.launch() });
  const challenge = await session.beginLogin("device-code");
  assert.deepEqual(challenge, {
    type: "device-code",
    loginId: "22222222-2222-4222-8222-222222222222",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
  await session.cancelLogin(challenge.loginId);
  assert.deepEqual(await session.waitForLogin(challenge.loginId), { state: "cancelled" });
  await session.close();
});

test("private managed-auth rejects an untrusted browser login URL", async () => {
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
    else if (message.method === "account/read") fake.send({ id: id(message), result: { account: null, requiresOpenaiAuth: true } });
    else if (message.method === "account/login/start") fake.send({ id: id(message), result: {
      type: "chatgpt",
      loginId: "33333333-3333-4333-8333-333333333333",
      authUrl: "https://example.test/collect-login",
    } });
  });
  const session = await CodexManagedAuthSession.open({ launch: server.launch() });
  await assert.rejects(session.beginLogin("browser"), protocolError("CODEX_MANAGED_AUTH_LOGIN_RESPONSE_INVALID"));
  await session.close();
});

test("private managed-auth rejects server token-refresh requests and proves startup-abort cleanup", async () => {
  let resolveRejection!: () => void;
  const rejected = new Promise<void>(resolve => { resolveRejection = resolve; });
  const controller = new AbortController();
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") {
      fake.send({ id: id(message), result: {} });
      queueMicrotask(() => fake.send({
        id: "external-token-refresh",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "supply a token" },
      }));
    } else if (message.id === "external-token-refresh") {
      assert.deepEqual(message.error, { code: -32601, message: "Unsupported private managed-auth request" });
      resolveRejection();
      controller.abort(new Error("close fixture after rejection"));
    }
  });

  await assert.rejects(CodexManagedAuthSession.open({ launch: server.launch() }, controller.signal), protocolError("CANCELLED"));
  await rejected;
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [true]);
});

test("private managed-auth fails closed when child exit and release cannot be proved", async () => {
  const server = new FakeManagedAuthAppServer((message, fake) => {
    if (message.method === "initialize") fake.send({ id: id(message), result: {} });
  }, false, false);
  const session = await CodexManagedAuthSession.open({ launch: server.launch() });
  await assert.rejects(session.close(), protocolError("CODEX_MANAGED_AUTH_RELEASE_UNCONFIRMED"));
  assert.equal(server.terminateCalls, 1);
  assert.deepEqual(server.releaseCalls, [false]);
});

test("private managed-auth releases a prepared child when protocol streams are unavailable", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let terminateCalls = 0;
  const releases: boolean[] = [];
  const launch: CodexManagedAuthLaunch = {
    id: "unavailable-stream-fixture",
    purpose: "private-managed-chatgpt-oauth",
    prepare: async () => ({
      child: {
        stdin: undefined,
        stdout,
        stderr,
        control: undefined,
        collected: {},
        done: Promise.resolve({ exitCode: 0 }),
        terminate: () => { terminateCalls += 1; stdout.end(); stderr.end(); },
        waitForExit: async () => true,
      },
      release: async stopped => { releases.push(stopped); return true; },
    }),
  };
  await assert.rejects(CodexManagedAuthSession.open({ launch }), protocolError("CODEX_APP_SERVER_STREAMS_UNAVAILABLE"));
  assert.equal(terminateCalls, 1);
  assert.deepEqual(releases, [true]);
});

import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import test from "node:test";
import { ManagedAuthEgressProxy } from "../src/adapters/managed-auth-egress-proxy.js";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing TCP address"));
      resolve(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function authorization(urlText: string): string {
  const url = new URL(urlText);
  return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
}

function requestProxy(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy fixture timed out"));
    }, 3000);
    socket.once("connect", () => socket.write(request));
    socket.on("data", chunk => { response += chunk.toString("latin1"); });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

test("managed-auth proxy opens one authenticated OpenAI login CONNECT tunnel and forwards TLS bytes", async () => {
  const origin = createServer(socket => socket.on("data", (chunk: Buffer) => socket.write(chunk)));
  const originPort = await listen(origin);
  const proxy = new ManagedAuthEgressProxy({
    resolveIPv4: async host => {
      assert.equal(host, "auth.openai.com");
      return ["8.8.8.8"];
    },
    connect: (address: string, port: number): Socket => {
      assert.equal(address, "8.8.8.8", "the resolved public address is pinned before dialing");
      assert.equal(port, 443);
      return createConnection({ host: "127.0.0.1", port: originPort });
    },
  });
  try {
    const binding = await proxy.start();
    const auth = authorization(binding.url);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: binding.port });
      let received = "";
      let probeSent = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("CONNECT tunnel fixture timed out"));
      }, 3000);
      socket.once("connect", () => socket.write([
        "CONNECT auth.openai.com:443 HTTP/1.1",
        "Host: auth.openai.com:443",
        `Proxy-Authorization: ${auth}`,
        "\r\nprobe-by-value",
      ].join("\r\n")));
      socket.on("data", chunk => {
        received += chunk.toString("latin1");
        const end = received.indexOf("\r\n\r\n");
        if (end >= 0 && !probeSent) {
          probeSent = true;
          socket.write("second-chunk");
        }
        if (end >= 0 && received.slice(end + 4).includes("probe-by-value") && received.slice(end + 4).includes("second-chunk")) {
          clearTimeout(timer);
          socket.end();
          resolve(received);
        }
      });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.match(response, /^HTTP\/1\.1 200 Connection Established\r\n/);
    assert.match(response, /probe-by-value/);
    assert.match(response, /second-chunk/);
  } finally {
    await proxy.close();
    await close(origin);
  }
});

test("managed-auth proxy rejects unauthenticated, non-OpenAI, and non-443 CONNECT requests before dialing", async () => {
  let dialCount = 0;
  const proxy = new ManagedAuthEgressProxy({
    resolveIPv4: async () => ["8.8.8.8"],
    connect: () => {
      dialCount += 1;
      throw new Error("rejected request reached dialer");
    },
  });
  try {
    const binding = await proxy.start();
    const validAuth = authorization(binding.url);
    const missingAuth = await requestProxy(binding.port, "CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\n\r\n");
    const wrongHost = await requestProxy(binding.port, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${validAuth}\r\n\r\n`);
    const wrongPort = await requestProxy(binding.port, `CONNECT auth.openai.com:8443 HTTP/1.1\r\nHost: auth.openai.com:8443\r\nProxy-Authorization: ${validAuth}\r\n\r\n`);
    assert.match(missingAuth, /^HTTP\/1\.1 407 /);
    assert.match(wrongHost, /^HTTP\/1\.1 403 /);
    assert.match(wrongPort, /^HTTP\/1\.1 403 /);
    assert.equal(dialCount, 0);
  } finally {
    await proxy.close();
  }
});

test("managed-auth proxy rejects private, special-use, and non-public DNS answers", async () => {
  let dialCount = 0;
  let answer = "127.0.0.1";
  const proxy = new ManagedAuthEgressProxy({
    resolveIPv4: async () => [answer],
    connect: () => {
      dialCount += 1;
      throw new Error("non-public DNS answer reached dialer");
    },
  });
  try {
    const binding = await proxy.start();
    const denied = [
      "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.0.1",
      "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1",
      "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
      "255.255.255.255", "not-an-ip",
    ];
    for (const address of denied) {
      answer = address;
      const response = await requestProxy(binding.port, `CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nProxy-Authorization: ${authorization(binding.url)}\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 502 /, `${address} must be rejected`);
    }
    assert.equal(dialCount, 0);
  } finally {
    await proxy.close();
  }
});

test("managed-auth proxy removes its loopback listener when closed", async () => {
  const proxy = new ManagedAuthEgressProxy();
  const binding = await proxy.start();
  await proxy.close();
  await assert.rejects(requestProxy(binding.port, "CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\n\r\n"));
});

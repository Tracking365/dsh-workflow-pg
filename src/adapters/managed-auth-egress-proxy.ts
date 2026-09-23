import { randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { DevkitError } from "../contracts/task.js";

const AUTH_HOSTS = new Set(["auth.openai.com"]);
const MAX_HEADER_BYTES = 16 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

interface ManagedAuthEgressProxyTestHooks {
  readonly resolveIPv4?: (host: string) => Promise<readonly string[]>;
  readonly connect?: (address: string, port: number) => Socket;
}

interface ParsedConnect {
  readonly ok: true;
  readonly host: string;
  readonly remainder: Buffer;
}

interface RejectedConnect {
  readonly ok: false;
  readonly status: 403 | 407;
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return undefined;
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

const NON_PUBLIC_IPV4: readonly (readonly [number, number])[] = [
  [0x00000000, 8],   // Current network.
  [0x0a000000, 8],   // Private.
  [0x64400000, 10],  // Shared address space.
  [0x7f000000, 8],   // Loopback.
  [0xa9fe0000, 16],  // Link-local.
  [0xac100000, 12],  // Private.
  [0xc0000000, 24],  // IETF protocol assignments.
  [0xc0000200, 24],  // Documentation.
  [0xc0586300, 24],  // Deprecated relay anycast.
  [0xc0a80000, 16],  // Private.
  [0xc6120000, 15],  // Benchmarking.
  [0xc6336400, 24],  // Documentation.
  [0xcb007100, 24],  // Documentation.
  [0xe0000000, 4],   // Multicast.
  [0xf0000000, 4],   // Reserved / broadcast.
];

function isPublicIPv4(value: string): boolean {
  const address = ipv4Number(value);
  if (address === undefined) return false;
  return NON_PUBLIC_IPV4.every(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return ((address & mask) >>> 0) !== network;
  });
}

function proxyUrl(port: number, username: string, password: string): string {
  const url = new URL(`http://127.0.0.1:${port}`);
  url.username = username;
  url.password = password;
  return url.toString();
}

/**
 * A short-lived, loopback-only CONNECT proxy for the dedicated managed-auth
 * App Server. It is intentionally not a general proxy: it accepts only an
 * authenticated CONNECT to auth.openai.com:443, resolves and pins public IPv4
 * addresses itself, and never logs request headers or tunnel contents.
 *
 * Do not reuse this capability for a task/candidate App Server. macOS Seatbelt
 * restrictions inherit into descendants; this proxy is safe only because the
 * managed-auth protocol has no thread, turn, tool, or candidate-workspace API.
 */
export class ManagedAuthEgressProxy {
  readonly id = "managed-auth-egress-proxy-v1";
  private readonly username = randomBytes(18).toString("base64url");
  private readonly password = randomBytes(32).toString("base64url");
  private readonly expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`, "ascii");
  private readonly resolveIPv4: (host: string) => Promise<readonly string[]>;
  private readonly connect: (address: string, port: number) => Socket;
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private closed = false;

  constructor(testHooks: ManagedAuthEgressProxyTestHooks = {}) {
    this.resolveIPv4 = testHooks.resolveIPv4 ?? (async host => await dns.resolve4(host));
    this.connect = testHooks.connect ?? ((address, port) => createConnection({ host: address, port }));
  }

  async start(): Promise<{ readonly port: number; readonly url: string }> {
    if (this.server !== undefined || this.closed) throw new DevkitError("MANAGED_AUTH_EGRESS_PROXY_NOT_STARTABLE");
    const server = createServer({ allowHalfOpen: true }, socket => this.accept(socket));
    server.maxConnections = 8;
    this.server = server;
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          const address = server.address();
          if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
            reject(new Error("proxy did not bind to IPv4 loopback"));
            return;
          }
          server.on("error", () => { void this.close(); });
          resolve(address.port);
        });
      });
      return Object.freeze({ port, url: proxyUrl(port, this.username, this.password) });
    } catch {
      this.closed = true;
      await this.stopServer(server);
      this.expectedAuthorization.fill(0);
      throw new DevkitError("MANAGED_AUTH_EGRESS_PROXY_START_FAILED");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server !== undefined) await this.stopServer(this.server);
    this.server = undefined;
    this.expectedAuthorization.fill(0);
  }

  private async stopServer(server: Server): Promise<void> {
    await new Promise<void>(resolve => {
      try { server.close(() => resolve()); }
      catch { resolve(); }
    });
  }

  private accept(client: Socket): void {
    this.track(client);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HEADER_BYTES) {
        client.removeListener("data", onData);
        this.reject(client, 431, "Request Header Fields Too Large");
        return;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.pause();
      client.removeListener("data", onData);
      const parsed = this.parseConnect(buffer.subarray(0, end), buffer.subarray(end + 4));
      if (!parsed.ok) {
        this.reject(client, parsed.status, parsed.status === 407 ? "Proxy Authentication Required" : "Forbidden");
        return;
      }
      void this.openTunnel(client, parsed).catch(() => this.reject(client, 502, "Bad Gateway"));
    };
    client.on("data", onData);
    client.once("timeout", () => client.destroy());
    client.setTimeout(CONNECT_TIMEOUT_MS);
    client.once("close", () => this.sockets.delete(client));
    client.once("error", () => client.destroy());
  }

  private parseConnect(header: Buffer, remainder: Buffer): ParsedConnect | RejectedConnect {
    const raw = header.toString("latin1");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) return { ok: false, status: 403 };
    const lines = raw.split("\r\n");
    if (lines.length < 2 || lines.length > 80) return { ok: false, status: 403 };
    const request = /^CONNECT ([A-Za-z0-9.-]+):([0-9]{1,5}) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!request || Number(request[2]) !== 443) return { ok: false, status: 403 };
    const host = request[1]!.toLowerCase();
    if (!AUTH_HOSTS.has(host)) return { ok: false, status: 403 };

    let authorization: string | undefined;
    let hostHeader: string | undefined;
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) return { ok: false, status: 403 };
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "proxy-authorization") {
        if (authorization !== undefined) return { ok: false, status: 403 };
        authorization = value;
      } else if (name === "host") {
        if (hostHeader !== undefined) return { ok: false, status: 403 };
        hostHeader = value.toLowerCase();
      } else if (name === "content-length" || name === "transfer-encoding") {
        return { ok: false, status: 403 };
      }
    }
    if (hostHeader !== host && hostHeader !== `${host}:443`) return { ok: false, status: 403 };
    if (authorization === undefined || !this.authorizationMatches(authorization)) return { ok: false, status: 407 };
    return { ok: true, host, remainder };
  }

  private authorizationMatches(value: string): boolean {
    const actual = Buffer.from(value, "ascii");
    try {
      return actual.length === this.expectedAuthorization.length && timingSafeEqual(actual, this.expectedAuthorization);
    } finally {
      actual.fill(0);
    }
  }

  private async openTunnel(client: Socket, parsed: ParsedConnect): Promise<void> {
    const addresses = await this.resolveIPv4(parsed.host);
    if (this.closed || addresses.length < 1 || addresses.length > 16 || addresses.some(address => !isPublicIPv4(address))) {
      throw new DevkitError("MANAGED_AUTH_EGRESS_DESTINATION_REJECTED");
    }
    if (client.destroyed) return;
    const upstream = this.connect(addresses[0]!, 443);
    this.track(upstream);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        upstream.destroy();
        reject(new Error("upstream timeout"));
      }, CONNECT_TIMEOUT_MS);
      upstream.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      upstream.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (this.closed || client.destroyed) {
      upstream.destroy();
      return;
    }
    client.setTimeout(0);
    upstream.setTimeout(0);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-devkit\r\n\r\n");
    if (parsed.remainder.length) upstream.write(parsed.remainder);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }

  private reject(socket: Socket, status: number, reason: string): void {
    if (socket.destroyed) return;
    const challenge = status === 407 ? "Proxy-Authenticate: Basic realm=\"managed-auth\"\r\n" : "";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
}

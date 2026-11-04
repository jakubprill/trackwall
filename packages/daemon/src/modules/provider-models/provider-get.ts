import type { Socket } from "node:net";
import { checkServerIdentity, type PeerCertificate, connect as tlsConnect } from "node:tls";
import { proxyFor } from "../../infra/proxy-env.ts";
import { DNS_CODES, openConnection, serverName, UNREACHABLE_CODES } from "../../infra/proxy-tunnel.ts";

/**
 * One `GET` to the model provider the way a session's Copilot CLI reaches it (ADR-194): directly or through an HTTP
 * `CONNECT` tunnel of the proxy its environment names (`infra/proxy-env.ts`), over TLS trusting only the certificates
 * given, with `Connection: close` so the answer ends with the connection. HTTP/1.1 is written by hand for the same reason
 * the tunnel is: `http.request` on a socket of one's own differs between Bun and Node. A failure is told by a fixed
 * phrase, never by a socket's message, which may name the provider's host: its address is a secret (ADR-136).
 */

export type ProviderAnswer = { kind: "answer"; status: number; body: string } | { kind: "failed"; reason: string };

export interface ProviderGetOptions {
  /** The session's environment, for its proxy settings. */
  env: NodeJS.ProcessEnv;
  /** The certificate authorities a session's Node.js trusts, as PEM. */
  ca: readonly string[];
  timeoutMs: number;
  /** More than this is not a list of models; the connection is cut. */
  maxBytes: number;
}

export async function providerGet(url: URL, headers: Readonly<Record<string, string>>, o: ProviderGetOptions): Promise<ProviderAnswer> {
  const scheme = url.protocol;
  if (scheme !== "http:" && scheme !== "https:") return { kind: "failed", reason: "its address is not an http or https address" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port === "" ? (scheme === "https:" ? 443 : 80) : Number(url.port);
  let proxy: URL | null;
  try {
    proxy = proxyFor(o.env, scheme, host, port);
  } catch {
    return { kind: "failed", reason: "the proxy for it is not an HTTP proxy" };
  }
  const deadline = Date.now() + o.timeoutMs;
  let raw: Socket | null = null;
  let socket: Socket | null = null;
  try {
    const opened = await openConnection({ host, port }, proxy, o.ca, o.timeoutMs);
    if ("kind" in opened) return { kind: "failed", reason: `the proxy did not open a connection to it (${opened.status})` };
    raw = opened.socket;
    socket = scheme === "https:" ? await secured(raw, host, o.ca, Math.max(1, deadline - Date.now())) : raw;
    return parseAnswer(await exchange(socket, request(url, headers), Math.max(1, deadline - Date.now()), o.maxBytes));
  } catch (err) {
    return { kind: "failed", reason: failure(err, proxy !== null) };
  } finally {
    // The TLS socket does not always end the socket under it (Bun), so both go.
    socket?.destroy();
    raw?.destroy();
  }
}

function request(url: URL, headers: Readonly<Record<string, string>>): string {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Accept: application/json",
    // Without compression the answer is read as it comes.
    "Accept-Encoding: identity",
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function secured(socket: Socket, host: string, ca: readonly string[], timeoutMs: number): Promise<Socket> {
  // An error of the socket underneath reaches the caller through the TLS socket; unheard here, it would crash the daemon.
  socket.on("error", () => {});
  return new Promise((resolve, reject) => {
    // Over a tunnel Node would check the certificate against the proxy's name when the host is an IP address (no SNI
    // then), so the provider's own host is checked explicitly.
    const tls = tlsConnect({
      socket,
      ...serverName(host),
      ca: [...ca],
      checkServerIdentity: (_name: string, cert: PeerCertificate) => checkServerIdentity(host, cert),
    });
    const timer = setTimeout(() => tls.destroy(Object.assign(new Error("no TLS answer in time"), { code: "ETIMEDOUT" })), timeoutMs);
    tls.once("secureConnect", () => {
      clearTimeout(timer);
      // Until the exchange listens, an error must still be heard, or it would crash the daemon.
      tls.removeAllListeners("error");
      tls.on("error", () => {});
      resolve(tls);
    });
    tls.once("error", (err: Error) => {
      clearTimeout(timer);
      tls.destroy();
      reject(err);
    });
  });
}

/** Sends the request and reads until the provider closes the connection. */
function exchange(socket: Socket, text: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("no answer in time"), { code: "ETIMEDOUT" })), timeoutMs);
    const done = (result: Buffer | Error) => {
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("end");
      socket.removeAllListeners("close");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return done(Object.assign(new Error("answer too large"), { code: "TOO_LARGE" }));
      chunks.push(chunk);
    });
    socket.once("end", () => done(Buffer.concat(chunks)));
    socket.once("close", () => done(Buffer.concat(chunks)));
    socket.once("error", (err) => done(err));
    socket.write(text);
  });
}

/** The status and body of an HTTP/1.1 answer read whole; a chunked body is joined, `Content-Length` cuts what follows. */
export function parseAnswer(raw: Buffer): ProviderAnswer {
  const end = raw.indexOf("\r\n\r\n");
  const head = end < 0 ? "" : raw.subarray(0, end).toString("latin1");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status === undefined) return { kind: "failed", reason: "its answer is not HTTP" };
  const fields = head.split("\r\n").slice(1);
  const field = (name: string) =>
    fields
      .find((line) => line.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim()
      .toLowerCase();
  let body = raw.subarray(end + 4);
  if (field("transfer-encoding")?.includes("chunked")) {
    const joined = dechunked(body);
    if (joined === null) return { kind: "failed", reason: "its answer was cut off" };
    body = joined;
  } else {
    const length = Number(field("content-length"));
    if (Number.isInteger(length) && length >= 0) {
      if (body.length < length) return { kind: "failed", reason: "its answer was cut off" };
      body = body.subarray(0, length);
    }
  }
  return { kind: "answer", status: Number(status), body: body.toString("utf8") };
}

/** A chunked body joined; `null` when it ends before its last, empty chunk. */
function dechunked(body: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", at);
    if (lineEnd < 0) return null;
    // A chunk's size may carry extensions after a semicolon; only plain hex digits are a size (no sign, which would loop back).
    const sizeText = (body.subarray(at, lineEnd).toString("latin1").split(";")[0] ?? "").trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) return null;
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (start + size > body.length) return null;
    parts.push(body.subarray(start, start + size));
    at = start + size + 2;
  }
}

function failure(err: unknown, viaProxy: boolean): string {
  const code = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? "") : "";
  if (code === "TOO_LARGE") return "its answer is too large for a list of models";
  if (code === "ETIMEDOUT") return "it did not answer in time";
  if (DNS_CODES.has(code)) return viaProxy ? "the proxy cannot be found" : "its host cannot be found";
  if (UNREACHABLE_CODES.has(code)) return viaProxy ? "the connection through the proxy failed" : "it does not accept connections";
  if (/CERT|SELF_SIGNED|UNABLE_TO/.test(code)) return `its certificate is not trusted (${code})`;
  return "the connection failed";
}

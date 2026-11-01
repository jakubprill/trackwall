import { isIP, connect as netConnect, type Socket } from "node:net";
import { type DetailedPeerCertificate, type TLSSocket, connect as tlsConnect } from "node:tls";
import { proxyPort } from "./proxy-env.ts";

/**
 * Opens a TLS connection to a host the way a Node.js program behind the user's proxy would (§4.15, ADR-166): through an
 * HTTP `CONNECT` tunnel when a proxy is given, trusting only the certificates given. It sends nothing after the handshake
 * and closes the connection at once, so it carries no data and no credential except the proxy's own login. The tunnel is
 * written by hand rather than with `http.request`, whose `CONNECT` support differs between Bun and Node.
 */

export type TlsProbeResult =
  | { kind: "ok" }
  /** The host's name, or the proxy's, could not be found. */
  | { kind: "dns"; message: string }
  /** The host, or the proxy when `proxy` is set, did not take the connection or did not answer in time. */
  | { kind: "unreachable"; message: string; proxy: boolean }
  /** The proxy answered `CONNECT` with another status than 200 (407: it wants a login). */
  | { kind: "proxy-refused"; status: number }
  /** The handshake worked, but the certificate is not one the given authorities sign, or not for this host. */
  | { kind: "untrusted"; code: string; issuer: string | null }
  | { kind: "error"; message: string };

interface TlsProbeOptions {
  proxy: URL | null;
  /** The certificate authorities to trust, as PEM. */
  ca: readonly string[];
  timeoutMs: number;
}

export type TlsProbe = (target: { host: string; port: number }, o: TlsProbeOptions) => Promise<TlsProbeResult>;

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);
/** A proxy's answer to `CONNECT` is a few short lines; more is not a proxy. */
const MAX_PROXY_ANSWER_BYTES = 16 * 1024;

export const probeTls: TlsProbe = async (target, o) => {
  const deadline = Date.now() + o.timeoutMs;
  let tunnel: Socket | null = null;
  try {
    if (o.proxy !== null) {
      const opened = await openTunnel(o.proxy, target, o.timeoutMs);
      if ("kind" in opened) return opened;
      tunnel = opened.socket;
    }
    return await handshake(target, tunnel, o.ca, Math.max(1, deadline - Date.now()));
  } catch (err) {
    return classify(err, o.proxy !== null && tunnel === null);
  } finally {
    tunnel?.destroy();
  }
};

/** The socket of a tunnel the proxy opened to the target, or why it did not. */
function openTunnel(proxy: URL, target: { host: string; port: number }, timeoutMs: number): Promise<{ socket: Socket } | TlsProbeResult> {
  return new Promise((resolve, reject) => {
    const host = proxy.hostname.replace(/^\[|\]$/g, "");
    const port = proxyPort(proxy);
    const socket: Socket = proxy.protocol === "https:" ? tlsConnect({ host, port, ...serverName(host) }) : netConnect({ host, port });
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error("the proxy did not answer in time"), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    let answer = Buffer.alloc(0);
    const done = (result: { socket: Socket } | TlsProbeResult | Error) => {
      clearTimeout(timer);
      // The tunnel goes on to carry the handshake, so these listeners must not see its later end.
      for (const event of ["data", "error", "close"]) socket.removeAllListeners(event);
      if (result instanceof Error) {
        socket.destroy();
        reject(result);
      } else {
        // An error of the tunnel's own socket reaches the handshake through the TLS socket on top; unheard here, it would crash the daemon.
        if ("socket" in result) socket.on("error", () => {});
        else socket.destroy();
        resolve(result);
      }
    };
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      const authority = `${target.host}:${target.port}`;
      const login = proxyLogin(proxy);
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...(login ? [`Proxy-Authorization: ${login}`] : [])];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (answer.length > MAX_PROXY_ANSWER_BYTES) done(new Error("the proxy's answer to CONNECT is not HTTP"));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(answer.subarray(0, end).toString("latin1"))?.[1];
      if (status === undefined) return done(new Error("the proxy's answer to CONNECT is not HTTP"));
      done(status === "200" ? { socket } : { kind: "proxy-refused", status: Number(status) });
    });
    socket.once("error", (err) => done(err));
    socket.once("close", () => done(new Error("the proxy closed the connection")));
  });
}

/** `Basic` with the user and password of the proxy's address, as Node's proxy agents send them; `null` without a user. */
function proxyLogin(proxy: URL): string | null {
  if (proxy.username === "") return null;
  const user = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(user, "utf8").toString("base64")}`;
}

function handshake(
  target: { host: string; port: number },
  tunnel: Socket | null,
  ca: readonly string[],
  timeoutMs: number,
): Promise<TlsProbeResult> {
  return new Promise((resolve, reject) => {
    // Not rejecting the certificate here lets the doctor name who signed it; nothing is sent over the connection either way.
    const socket: TLSSocket = tlsConnect({
      ...(tunnel === null ? { host: target.host, port: target.port } : { socket: tunnel }),
      ...serverName(target.host),
      ca: [...ca],
      rejectUnauthorized: false,
    });
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error(`${target.host} did not answer in time`), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const result: TlsProbeResult = socket.authorized
        ? { kind: "ok" }
        : { kind: "untrusted", code: String(socket.authorizationError), issuer: rootIssuer(socket.getPeerCertificate(true)) };
      socket.destroy();
      resolve(result);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

/** TLS sends a host's name to the server (SNI), never an IP address, which Node refuses there. */
function serverName(host: string): { servername?: string } {
  return isIP(host) === 0 ? { servername: host } : {};
}

/** The name of whoever signed the top of the chain the server sent: a company's inspecting proxy names itself there. */
function rootIssuer(cert: DetailedPeerCertificate | undefined): string | null {
  let current = cert;
  const seen = new Set<DetailedPeerCertificate>();
  while (current?.issuerCertificate && current.issuerCertificate !== current && !seen.has(current)) {
    seen.add(current);
    current = current.issuerCertificate;
  }
  const name = current?.issuer?.CN ?? current?.issuer?.O;
  // A name given twice in a certificate comes as a list.
  return (Array.isArray(name) ? name[0] : name) ?? null;
}

function classify(err: unknown, atProxy: boolean): TlsProbeResult {
  const { code, message } = err as NodeJS.ErrnoException;
  if (code !== undefined && DNS_CODES.has(code)) return { kind: "dns", message };
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return { kind: "unreachable", message, proxy: atProxy };
  if (atProxy) return { kind: "unreachable", message, proxy: true };
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

import type { Socket } from "node:net";
import { type DetailedPeerCertificate, type TLSSocket, connect as tlsConnect } from "node:tls";
import { connectDirectly, openTunnel, serverName } from "../../infra/proxy-tunnel.ts";

/**
 * Opens a connection to a host the way a Node.js program behind the user's proxy would (§4.15) and closes it at once:
 * through an HTTP `CONNECT` tunnel when a proxy is given, trusting only the certificates given. `probeTls` makes a TLS
 * handshake with the host (ADR-166), `probeConnection` only connects (ADR-179). Neither sends data or a credential except
 * the proxy's own login; the connection itself is `infra/proxy-tunnel.ts`.
 */

export type TlsProbeResult =
  | { kind: "ok" }
  /** The host's name, or the proxy's, could not be found. */
  | { kind: "dns"; message: string }
  /** The host, or the proxy when `proxy` is set, did not take the connection or did not answer in time. */
  | { kind: "unreachable"; message: string; proxy: boolean }
  /** The proxy answered `CONNECT` with another status than 200 (407: it wants a login). */
  | { kind: "proxy-refused"; status: number }
  /** The certificate of the host, or of an HTTPS proxy, is not one the given authorities sign, or not for that host. */
  | { kind: "untrusted"; code: string; issuer: string | null; proxy: boolean }
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

export const probeTls: TlsProbe = async (target, o) => {
  const deadline = Date.now() + o.timeoutMs;
  let tunnel: Socket | null = null;
  try {
    if (o.proxy !== null) {
      const opened = await openTunnel(o.proxy, target, o.ca, o.timeoutMs);
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

/**
 * Opens a connection to a host and closes it at once, through an HTTP `CONNECT` tunnel when a proxy is given (§4.15,
 * ADR-179): nothing goes to the host, not even a TLS greeting, and the proxy gets only `CONNECT host:port` with its own
 * login. It tells whether something accepts connections there, which is all the doctor may learn about a model provider
 * without sending it a request. Only an HTTPS proxy's own certificate can be `untrusted` here.
 */
export const probeConnection: TlsProbe = async (target, o) => {
  let socket: Socket | null = null;
  try {
    const opened =
      o.proxy === null ? { socket: await connectDirectly(target, o.timeoutMs) } : await openTunnel(o.proxy, target, o.ca, o.timeoutMs);
    if ("kind" in opened) return opened;
    socket = opened.socket;
    return { kind: "ok" };
  } catch (err) {
    return classify(err, o.proxy !== null);
  } finally {
    socket?.destroy();
  }
};

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
        : { kind: "untrusted", code: String(socket.authorizationError), issuer: rootIssuer(socket.getPeerCertificate(true)), proxy: false };
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

/**
 * OpenSSL's verify codes for a certificate it does not accept, and Node's for one issued to another host. Not the TLS
 * alerts (`ERR_SSL_..._ALERT_BAD_CERTIFICATE`, a proxy wanting a client certificate), which no CA list fixes.
 */
const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function classify(err: unknown, atProxy: boolean): TlsProbeResult {
  if (!(err instanceof Error)) return { kind: "error", message: String(err) };
  const { code = "", message } = err as NodeJS.ErrnoException;
  if (DNS_CODES.has(code)) return { kind: "dns", message };
  if (CERTIFICATE_CODES.has(code)) return { kind: "untrusted", code, issuer: null, proxy: atProxy };
  if (UNREACHABLE_CODES.has(code) || atProxy) return { kind: "unreachable", message, proxy: atProxy };
  return { kind: "error", message };
}

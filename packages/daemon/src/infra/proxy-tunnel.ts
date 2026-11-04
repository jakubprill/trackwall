import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { proxyPort } from "./proxy-env.ts";

/**
 * A connection to a host the way a Node.js program behind the user's proxy opens it (§4.15): directly, or through an
 * HTTP `CONNECT` tunnel written by hand rather than with `http.request`, whose `CONNECT` support differs between Bun and
 * Node. The doctor's probes (ADR-166, ADR-179) and the provider's model list (ADR-194) open their connections here.
 */

/** The tunnel's socket, or the proxy's answer when it did not open one (407: it wants a login). */
export type TunnelResult = { socket: Socket } | { kind: "proxy-refused"; status: number };

/** A proxy's answer to `CONNECT` is a few short lines; more is not a proxy. */
const MAX_PROXY_ANSWER_BYTES = 16 * 1024;

/** The socket of a tunnel the proxy opened to the target, or why it did not. */
export function openTunnel(
  proxy: URL,
  target: { host: string; port: number },
  ca: readonly string[],
  timeoutMs: number,
): Promise<TunnelResult> {
  // Written before connecting, so that nothing in it can throw inside a socket's listener, where it would crash the daemon.
  const request = connectRequest(proxy, target);
  return new Promise((resolve, reject) => {
    const host = proxy.hostname.replace(/^\[|\]$/g, "");
    const port = proxyPort(proxy);
    // An HTTPS proxy's own certificate is checked against the same authorities as the host's, as Node's proxy agent does.
    const socket: Socket =
      proxy.protocol === "https:" ? tlsConnect({ host, port, ...serverName(host), ca: [...ca] }) : netConnect({ host, port });
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error("the proxy did not answer in time"), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    let answer = Buffer.alloc(0);
    const done = (result: TunnelResult | Error) => {
      clearTimeout(timer);
      // The tunnel goes on to carry what the caller sends, so these listeners must not see its later end.
      for (const event of ["data", "error", "close"]) socket.removeAllListeners(event);
      if (result instanceof Error) {
        socket.destroy();
        reject(result);
      } else {
        // An error of the tunnel's own socket reaches the caller through what it puts on top; unheard here, it would crash the daemon.
        if ("socket" in result) socket.on("error", () => {});
        else socket.destroy();
        resolve(result);
      }
    };
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (answer.length > MAX_PROXY_ANSWER_BYTES) done(new Error("the proxy's answer to CONNECT is not HTTP"));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(answer.subarray(0, end).toString("latin1"))?.[1];
      if (status === undefined) return done(new Error("the proxy's answer to CONNECT is not HTTP"));
      // Any 2xx opens the tunnel (RFC 9110, CONNECT).
      done(status.startsWith("2") ? { socket } : { kind: "proxy-refused", status: Number(status) });
    });
    socket.once("error", (err) => done(err));
    socket.once("close", () => done(new Error("the proxy closed the connection")));
  });
}

export function connectDirectly(target: { host: string; port: number }, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.host, port: target.port });
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error(`${target.host} did not answer in time`), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

function connectRequest(proxy: URL, target: { host: string; port: number }): string {
  const authority = `${target.host}:${target.port}`;
  const login = proxyLogin(proxy);
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...(login ? [`Proxy-Authorization: ${login}`] : [])];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** `Basic` with the user and password of the proxy's address, as Node's proxy agents send them; `null` without a user. */
function proxyLogin(proxy: URL): string | null {
  if (proxy.username === "") return null;
  const user = `${decoded(proxy.username)}:${decoded(proxy.password)}`;
  return `Basic ${Buffer.from(user, "utf8").toString("base64")}`;
}

/** A part of an address with its `%` escapes decoded; one that is not a valid escape (`%zz`) stays as written. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** TLS sends a host's name to the server (SNI), never an IP address, which Node refuses there. */
export function serverName(host: string): { servername?: string } {
  return isIP(host) === 0 ? { servername: host } : {};
}

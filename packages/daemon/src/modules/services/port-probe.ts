import { connect } from "node:net";

/**
 * Readiness probe of a service (§4.3, ADR-45): a TCP connection to the port on loopback. IPv4 first, then IPv6,
 * because Node dev servers on `localhost` often listen only on `::1`. The answer says which address took the
 * connection, so the endpoint call goes to the same one.
 */

/** A dev server under load accepts a connection in milliseconds; a second means nothing listens. */
const CONNECT_TIMEOUT_MS = 1000;

/** Loopback addresses in the order they are tried, as the host of a URL. */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

/** The loopback address on which something accepts connections on `port`, or `null`. */
export async function probePort(port: number): Promise<LoopbackHost | null> {
  for (const host of LOOPBACK_HOSTS) if (await accepts(host, port)) return host;
  return null;
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

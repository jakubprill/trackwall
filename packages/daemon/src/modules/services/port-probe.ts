import { connect } from "node:net";
import { LOOPBACK_HOSTS, type LoopbackHost } from "../../infra/loopback.ts";

/**
 * Readiness probe of a service (§4.3, ADR-45): a TCP connection to the port on loopback, IPv4 and IPv6 at once,
 * because Node dev servers on `localhost` often listen only on `::1` and a refused connection on Windows takes about
 * two seconds. The answer says which address took the connection (IPv4 when both did), so the endpoint call goes there.
 */

/** A dev server under load accepts a connection in milliseconds; a second means nothing listens. */
const CONNECT_TIMEOUT_MS = 1000;

/** The loopback address on which something accepts connections on `port`, or `null`. */
export async function probePort(port: number): Promise<LoopbackHost | null> {
  const answers = await Promise.all(LOOPBACK_HOSTS.map((host) => accepts(host, port)));
  return LOOPBACK_HOSTS.find((_, i) => answers[i]) ?? null;
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

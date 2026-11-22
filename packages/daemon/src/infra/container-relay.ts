import { connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { containerProxyPort } from "./args.ts";
import { appendNote } from "./container-log.ts";
import { messageOf } from "./errors.ts";

/**
 * The relay of a dev container whose ports Docker publishes (ADR-287): the daemon and the service proxy listen only on
 * 127.0.0.1, which Docker cannot publish, so the relay listens on the container's own addresses on the same port numbers
 * and passes every connection on to 127.0.0.1, byte for byte. It reads nothing and adds nothing: the daemon's checks of
 * `Host`, `Origin` and the token still apply to every request. Started by the Feature's entrypoint with its `publish`
 * option, so it runs after every start of the container, with or without VS Code.
 */

export interface RelayRoute {
  listen: { host: string; port: number };
  /** Always on 127.0.0.1: the relay passes connections on to Trackwall only. */
  targetPort: number;
}

const LOOPBACK = "127.0.0.1";

/** The container's own IPv4 addresses, the ones Docker forwards published ports to; never the loopback. */
export function containerAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  return Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

/** The routes for Trackwall's ports: each port on each container address to the same port on 127.0.0.1. */
export function relayRoutes(ports: readonly number[], addresses: readonly string[]): RelayRoute[] {
  return addresses.flatMap((host) => ports.map((port) => ({ listen: { host, port }, targetPort: port })));
}

/** Passes one connection on to 127.0.0.1; an end or error on either side ends both. */
function pass(client: Socket, targetPort: number): void {
  const upstream = connect({ host: LOOPBACK, port: targetPort });
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
  client.pipe(upstream);
  upstream.pipe(client);
}

/** Listens on one route; an error after that (no file descriptors left, say) goes to `onError`, and the route keeps listening. */
function listen(route: RelayRoute, onError: (msg: string) => void): Promise<Server> {
  const server = createServer((client) => pass(client, route.targetPort));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(route.listen.port, route.listen.host, () => {
      server.off("error", reject);
      server.on("error", (err) => onError(`${route.listen.host}:${route.listen.port}: ${messageOf(err)}`));
      resolve(server);
    });
  });
}

/** Listens on every route; a route that cannot listen closes the others and fails the start, saying which one. */
export async function startRelay(
  routes: readonly RelayRoute[],
  onError: (msg: string) => void = () => {},
): Promise<{ close(): Promise<void> }> {
  if (routes.length === 0) throw new Error("the container has no address besides 127.0.0.1 to listen on");
  const servers: Server[] = [];
  const close = () => Promise.all(servers.map((server) => new Promise<void>((r) => server.close(() => r())))).then(() => {});
  for (const route of routes) {
    try {
      servers.push(await listen(route, onError));
    } catch (err) {
      await close();
      throw new Error(`cannot listen on ${route.listen.host}:${route.listen.port}: ${messageOf(err)}`);
    }
  }
  return { close };
}

/**
 * `trackwall-container relay`: the relay for the daemon's port and the service proxy's after it, until the container
 * stops. What it listens on, or why it cannot, goes to `logs/daemon.log`, since the entrypoint gives it no terminal.
 */
export async function runContainerRelay(logPath: string, port: number): Promise<boolean> {
  const proxyPort = containerProxyPort(port);
  const routes = relayRoutes(proxyPort === null ? [port] : [port, proxyPort], containerAddresses());
  try {
    await startRelay(routes, (msg) => appendNote(logPath, "relay", msg));
  } catch (err) {
    appendNote(logPath, "relay", `not started: ${messageOf(err)}`);
    return false;
  }
  const listening = routes.map(({ listen }) => `${listen.host}:${listen.port}`).join(", ");
  appendNote(logPath, "relay", `passing ${listening} on to the same ports on 127.0.0.1`);
  return true;
}

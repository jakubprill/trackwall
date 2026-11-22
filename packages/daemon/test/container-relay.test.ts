import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseCommandLine } from "../src/infra/args.ts";
import { containerAddresses, relayRoutes, startRelay } from "../src/infra/container-relay.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";

const servers: Server[] = [];
const relays: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

/** An HTTP server on 127.0.0.1 that answers with the Host header it got, standing in for the daemon. */
async function daemonStandIn(): Promise<number> {
  const server = createServer((req, res) => res.end(`host ${req.headers.host}`));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

/** A free port on 127.0.0.1, for the relay to listen on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("the relay for ports Docker publishes (ADR-288)", () => {
  test("it listens on the container's own IPv4 addresses, never the loopback or IPv6", () => {
    expect(
      containerAddresses({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: null }],
        eth0: [
          { address: "172.17.0.2", family: "IPv4", internal: false, netmask: "255.255.0.0", mac: "02:42:ac:11:00:02", cidr: null },
          {
            address: "fe80::42:acff:fe11:2",
            family: "IPv6",
            internal: false,
            netmask: "ffff:ffff:ffff:ffff::",
            mac: "02:42:ac:11:00:02",
            cidr: null,
            scopeid: 2,
          },
        ],
      }),
    ).toEqual(["172.17.0.2"]);
  });

  test("each of Trackwall's ports on each address goes to the same port on 127.0.0.1", () => {
    expect(relayRoutes([7700, 7701], ["172.17.0.2"])).toEqual([
      { listen: { host: "172.17.0.2", port: 7700 }, targetPort: 7700 },
      { listen: { host: "172.17.0.2", port: 7701 }, targetPort: 7701 },
    ]);
  });

  test("a request through the relay reaches the daemon unchanged, Host header included, so the daemon's checks still apply", async () => {
    const daemonPort = await daemonStandIn();
    const relayPort = await freePort();
    relays.push(await startRelay([{ listen: { host: "127.0.0.1", port: relayPort }, targetPort: daemonPort }]));

    const res = await loopbackRequest(relayPort, "/api/health", { headers: { host: `127.0.0.1:${daemonPort}` } });

    expect(res.body).toBe(`host 127.0.0.1:${daemonPort}`);
  });

  test("a port that is taken fails the start, naming the address, and leaves nothing listening", async () => {
    const taken = await daemonStandIn();
    const free = await freePort();
    await expect(
      startRelay([
        { listen: { host: "127.0.0.1", port: free }, targetPort: taken },
        { listen: { host: "127.0.0.1", port: taken }, targetPort: taken },
      ]),
    ).rejects.toThrow(`cannot listen on 127.0.0.1:${taken}`);
    const again = await startRelay([{ listen: { host: "127.0.0.1", port: free }, targetPort: taken }]);
    relays.push(again);
  });

  test("a container without an address besides the loopback has nothing to relay", async () => {
    await expect(startRelay([])).rejects.toThrow("no address besides 127.0.0.1");
  });

  test("`container relay` takes the Feature's port like start", () => {
    expect(parseCommandLine(["container", "relay", "--port", "7800"])).toEqual({
      command: "container",
      action: "relay",
      port: 7800,
      home: undefined,
    });
  });
});

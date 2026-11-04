import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { join } from "node:path";
import { DaemonInfoResult, servicesApi } from "@trackwall/protocol";
import { throughProxy } from "../src/api/service-proxy.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (`fixtures/fake-mise.ts`): `dev` runs `fixtures/fake-service.ts`, which logs its port. */
const SERVICE = JSON.stringify({ tasks: [{ name: "dev" }], servers: { dev: {} } });
const TIMEOUT = 60_000;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let proxyPort: number;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "fake-mise.json": SERVICE }, warehouse: { "fake-mise.json": SERVICE } },
    miseCommand: FAKE_MISE,
    proxyPort: 0,
  });
  if (daemon.api.proxyPort === null) throw new Error("the service proxy did not start");
  proxyPort = daemon.api.proxyPort;
  const slice = await daemon.post(servicesApi.start, { repo: "shop", task: null, lease: false, dependencies: false, waitMs: 8000 });
  if (!slice.settled) throw new Error("the service of shop did not settle");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
});

/** A request to the proxy as a browser sends it, with the `Host` of the address it opened. */
function viaProxy(host: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("the service proxy (ADR-189, real process groups, fake mise and fake service)", () => {
  test(
    "a page at shop.localhost reaches the running service of shop with the browser's Host, and the service's redirect to its own address comes back through the proxy",
    async () => {
      const host = `shop.localhost:${proxyPort}`;
      const page = await viaProxy(host, "/api/orders?status=open");
      expect(page.status).toBe(200);
      expect(JSON.parse(page.body)).toMatchObject({ method: "GET", path: "/api/orders?status=open", host, forwardedHost: host });

      const login = await viaProxy(host, "/redirect");
      expect(login.status).toBe(302);
      expect(login.headers.location).toBe(`http://${host}/login?next=1`);
    },
    TIMEOUT,
  );

  test(
    "a WebSocket opened at shop.localhost reaches the service, and what the page sends comes back",
    async () => {
      const socket = connect({ host: "127.0.0.1", port: proxyPort });
      await new Promise((resolve) => socket.once("connect", resolve));
      const received: Buffer[] = [];
      socket.on("data", (c: Buffer) => received.push(c));
      socket.write(
        [
          "GET /live-reload HTTP/1.1",
          `Host: shop.localhost:${proxyPort}`,
          `Origin: http://shop.localhost:${proxyPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "",
          "",
        ].join("\r\n"),
      );
      await until(() => Buffer.concat(received).toString().includes("\r\n\r\n"));
      socket.write("ping");
      await until(() => Buffer.concat(received).toString().endsWith("ping"));
      const text = Buffer.concat(received).toString();
      expect(text).toStartWith("HTTP/1.1 101 Switching Protocols");
      expect(text).toContain("x-path: /live-reload");
      socket.destroy();
    },
    TIMEOUT,
  );

  test(
    "a service that has not been started answers 502 naming it, and a name that is no repo's the same",
    async () => {
      const warehouse = await viaProxy(`warehouse.localhost:${proxyPort}`, "/");
      expect(warehouse.status).toBe(502);
      expect(warehouse.body).toBe("The service of warehouse has not been started. Start it in Trackwall, then reload.\n");
      expect((await viaProxy(`nowhere.localhost:${proxyPort}`, "/")).status).toBe(502);
    },
    TIMEOUT,
  );

  test(
    "an address that is not a service's name is refused: the bare port, another domain rebound to 127.0.0.1, another port",
    async () => {
      for (const host of [
        `127.0.0.1:${proxyPort}`,
        `localhost:${proxyPort}`,
        `shop.evil.example:${proxyPort}`,
        `shop.localhost:${daemon.api.port}`,
      ]) {
        const answer = await viaProxy(host, "/api/orders");
        expect({ host, status: answer.status }).toEqual({ host, status: 404 });
        expect(answer.body).toBe(
          `Trackwall opens a running service at http://<repo>.localhost:${proxyPort}/, with the repo's name in place of <repo>.\n`,
        );
      }
    },
    TIMEOUT,
  );

  test(
    "a request from a page of another site is refused, from a page of another service behind the proxy it passes",
    async () => {
      const host = `shop.localhost:${proxyPort}`;
      const fromSite = await viaProxy(host, "/api/orders", { origin: "https://evil.example" });
      expect(fromSite.status).toBe(403);
      expect(fromSite.body).toBe("Trackwall passes no request from a page of another site to a service.\n");
      expect((await viaProxy(host, "/api/orders", { origin: `http://127.0.0.1:${daemon.api.port}` })).status).toBe(403);
      expect((await viaProxy(host, "/api/orders", { origin: `http://web.localhost:${proxyPort}` })).status).toBe(200);
    },
    TIMEOUT,
  );

  test("the daemon's info gives the proxy's port, so the page builds the addresses", async () => {
    const res = await loopbackRequest(daemon.api.port, "/api/daemon/info", { token: TOKEN });
    expect(DaemonInfoResult.parse(JSON.parse(res.body))).toMatchObject({ ok: true, data: { serviceProxyPort: proxyPort } });
  });
});

describe("the service proxy's port", () => {
  test(
    "a port that is taken leaves the daemon running without the proxy, with a line in its log",
    async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      const port = (taken.address() as AddressInfo).port;
      const log: string[] = [];
      const other = await startSessionApi(TOKEN, { repos: { shop: {} }, miseCommand: FAKE_MISE, proxyPort: port, log: (l) => log.push(l) });
      try {
        expect(other.api.proxyPort).toBeNull();
        expect(log).toContain(`no service proxy: port ${port} could not be opened (EADDRINUSE)`);
      } finally {
        await other.stop();
        taken.close();
      }
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

describe("a redirect through the proxy", () => {
  test("the service's own loopback address becomes the proxy's, any other address stays", () => {
    const host = "shop.localhost:7701";
    expect(throughProxy("http://localhost:8080/login", 8080, host)).toBe("http://shop.localhost:7701/login");
    expect(throughProxy("http://127.0.0.1:8080", 8080, host)).toBe("http://shop.localhost:7701");
    expect(throughProxy("http://[::1]:8080?x=1", 8080, host)).toBe("http://shop.localhost:7701?x=1");
    expect(throughProxy("/login", 8080, host)).toBe("/login");
    expect(throughProxy("http://localhost:80801/login", 8080, host)).toBe("http://localhost:80801/login");
    expect(throughProxy("https://sso.example.com/auth", 8080, host)).toBe("https://sso.example.com/auth");
  });
});

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!done()) throw new Error("timed out");
}

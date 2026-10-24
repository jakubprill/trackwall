import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { agentsApi, PTY_CLOSE_NOT_FOUND, PTY_SUBPROTOCOL } from "@trackwall/protocol";
import WebSocket from "ws";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "p".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
});

afterAll(() => daemon.stop());

/** Klient terminala: zbiera obraz ekranu i wyjście jako tekst. */
function connect(session: string, protocols: string[], headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws/pty/${session}`, protocols, { headers });
  let text = "";
  ws.on("message", (data: Buffer) => {
    text += data.toString("utf8");
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, opened, closed, text: () => text };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`nie doczekano się: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("terminal sesji przez WebSocket", () => {
  test("okno dostaje ekran sesji, a klawisze i rozmiar trafiają do Copilot CLI", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "sklep" });
    const client = connect(session.id, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]);
    await client.opened;
    expect(client.ws.protocol).toBe(PTY_SUBPROTOCOL);
    await until(() => client.text().includes("Witaj w atrapie"), "ekran powitalny");

    client.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    client.ws.send(JSON.stringify({ type: "input", data: "napraw build\r" }));
    await until(() => client.text().includes("Zezwolić na bash?"), "prośba o zgodę na ekranie");
    await until(async () => {
      const list = await daemon.post(agentsApi.sessions, {});
      return list.sessions.find((s) => s.id === session.id)?.state?.state === "Approval";
    }, "stan Approval z hooka");

    client.ws.close();
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("bez tokenu, z obcym Origin albo do nieznanej sesji połączenie jest odrzucane", async () => {
    const session = "00000000-0000-4000-8000-000000000000";
    await expect(connect(session, [PTY_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect(session, [PTY_SUBPROTOCOL, `bearer.${"x".repeat(43)}`]).opened).rejects.toThrow("status 401");
    await expect(connect(session, [`bearer.${TOKEN}`]).opened).rejects.toThrow("status 400");
    await expect(connect(session, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`], { origin: "https://evil.example" }).opened).rejects.toThrow(
      "status 403",
    );
    expect(await connect("nie-uuid", [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]).closed).toBe(PTY_CLOSE_NOT_FOUND);

    const unknown = connect(session, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]);
    expect(await unknown.closed).toBe(PTY_CLOSE_NOT_FOUND);
  });

  test("żądanie z adresem, którego nie da się sparsować, dostaje 404, a daemon działa dalej", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(daemon.api.port, "127.0.0.1", () => {
        socket.write(
          `GET http://[x/ HTTP/1.1\r\nHost: 127.0.0.1:${daemon.api.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Protocol: ${PTY_SUBPROTOCOL}, bearer.${TOKEN}\r\n\r\n`,
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
    });
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
    const health = await loopbackRequest(daemon.api.port, "/api/health", { method: "GET", timeoutMs: 5000 });
    expect(health.status).toBe(200);
  });
});

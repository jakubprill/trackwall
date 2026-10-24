import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentsApi, DaemonEvent, EVENTS_SOCKET } from "@trackwall/protocol";

const EVENTS_SUBPROTOCOL = EVENTS_SOCKET.subprotocol;

import WebSocket from "ws";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "e".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
});

afterAll(() => daemon.stop());

/** Klient zdarzeń: zbiera zdarzenia sprawdzone kontraktem. */
function connect(path: string, protocols: string[], headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}${path}`, protocols, { headers });
  const events: DaemonEvent[] = [];
  ws.on("message", (data: Buffer) => events.push(DaemonEvent.parse(JSON.parse(data.toString("utf8")))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  return { ws, opened, events };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`nie doczekano się: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("zdarzenia daemona przez WebSocket /ws", () => {
  test("klient dostaje najpierw migawkę każdego tematu, a potem nową sesję i jej stan bez odpytywania", async () => {
    const client = connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`]);
    await client.opened;
    expect(client.ws.protocol).toBe(EVENTS_SUBPROTOCOL);
    await until(() => client.events.length >= 2, "migawki na start");
    expect(client.events.map((e) => e.type).sort()).toEqual(DaemonEvent.options.map((o) => o.shape.type.value).sort());
    expect(client.events.find((e) => e.type === "sessions.changed")?.payload).toMatchObject({ sessions: [], tasks: [] });

    const session = await daemon.post(agentsApi.start, { repo: "sklep" });
    const sessionsIn = (e: DaemonEvent) => (e.type === "sessions.changed" ? e.payload.sessions : []);
    await until(
      () => client.events.some((e) => sessionsIn(e).some((s) => s.id === session.id && s.state?.state === "Input")),
      "stan Input z hooka",
    );

    await daemon.post(agentsApi.stop, { session: session.id });
    await until(() => client.events.some((e) => sessionsIn(e).some((s) => s.id === session.id && s.run.kind === "exited")), "koniec sesji");
    client.ws.close();
  }, 60_000);

  test("bez tokenu, z obcym Origin, bez podprotokołu zdarzeń albo pod nieznanym adresem połączenie jest odrzucane", async () => {
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${"x".repeat(43)}`]).opened).rejects.toThrow("status 401");
    // Bez tokenu nieznany adres też daje 401: klient bez tokenu nie pozna adresów daemona.
    await expect(connect("/ws/inne", [EVENTS_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect("/ws", ["trackwall.pty", `bearer.${TOKEN}`]).opened).rejects.toThrow("status 400");
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`], { origin: "https://evil.example" }).opened).rejects.toThrow(
      "status 403",
    );
    await expect(connect("/ws/inne", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`]).opened).rejects.toThrow("status 404");
  });
});

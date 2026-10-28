import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentsApi, DaemonEvent, EVENTS_SOCKET } from "@trackwall/protocol";

import WebSocket from "ws";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "e".repeat(43);
const EVENTS_SUBPROTOCOL = EVENTS_SOCKET.subprotocol;
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

/** An event client: collects events checked by the contract. */
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
    if (Date.now() > deadline) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("daemon events over the /ws WebSocket", () => {
  test("a client first gets a snapshot of every topic, then a new session and its state without polling", async () => {
    const client = connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`]);
    await client.opened;
    expect(client.ws.protocol).toBe(EVENTS_SUBPROTOCOL);
    await until(() => client.events.length >= 2, "snapshots at start");
    expect(client.events.map((e) => e.type).sort()).toEqual(DaemonEvent.options.map((o) => o.shape.type.value).sort());
    expect(client.events.find((e) => e.type === "sessions.changed")?.payload).toMatchObject({ sessions: [], tasks: [] });

    const session = await daemon.post(agentsApi.start, { repo: "shop" });
    const sessionsIn = (e: DaemonEvent) => (e.type === "sessions.changed" ? e.payload.sessions : []);
    await until(
      () => client.events.some((e) => sessionsIn(e).some((s) => s.id === session.id && s.state?.state === "Input")),
      "Input state from the hook",
    );

    await daemon.post(agentsApi.stop, { session: session.id });
    await until(
      () => client.events.some((e) => sessionsIn(e).some((s) => s.id === session.id && s.run.kind === "exited")),
      "end of the session",
    );
    client.ws.close();
  }, 60_000);

  test("a connection without a token, with a foreign Origin, without the events subprotocol or at an unknown address is refused", async () => {
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${"x".repeat(43)}`]).opened).rejects.toThrow("status 401");
    // Without a token an unknown address also gives 401: a client without a token does not learn the daemon's addresses.
    await expect(connect("/ws/other", [EVENTS_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect("/ws", ["trackwall.pty", `bearer.${TOKEN}`]).opened).rejects.toThrow("status 400");
    await expect(connect("/ws", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`], { origin: "https://evil.example" }).opened).rejects.toThrow(
      "status 403",
    );
    await expect(connect("/ws/other", [EVENTS_SUBPROTOCOL, `bearer.${TOKEN}`]).opened).rejects.toThrow("status 404");
  });
});

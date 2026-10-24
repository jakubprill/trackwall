import { describe, expect, test } from "bun:test";
import type { SessionList } from "@trackwall/protocol";
import { DaemonEvents, type EventSocket } from "../src/lib/daemon-events.ts";

const LIST: SessionList = { sessions: [], tasks: [], proposals: [], worktreesDir: "/stan/worktrees" };

/** Atrapa WebSocketu przeglądarki: test sam otwiera, przysyła ramki i zamyka połączenie. */
function fakeSockets() {
  const opened: { url: string; protocols: string[]; socket: EventSocket }[] = [];
  const openSocket = (url: string, protocols: string[]) => {
    const socket = { onopen: null, onmessage: null, onclose: null, close: () => {} } as unknown as EventSocket;
    opened.push({ url, protocols, socket });
    return socket;
  };
  const last = () => {
    const entry = opened.at(-1);
    if (!entry) throw new Error("brak połączenia");
    return entry.socket;
  };
  const message = (data: unknown) => last().onmessage?.call(last() as WebSocket, new MessageEvent("message", { data }));
  const open = () => last().onopen?.call(last() as WebSocket, new Event("open"));
  const close = () => last().onclose?.call(last() as WebSocket, new CloseEvent("close"));
  return { opened, openSocket, message, open, close };
}

function makeEvents(sockets: ReturnType<typeof fakeSockets>) {
  return new DaemonEvents({
    conn: { baseUrl: "http://127.0.0.1:4100", token: "sekret" },
    location: { protocol: "tauri:", host: "localhost" },
    openSocket: sockets.openSocket,
  });
}

describe("zdarzenia daemona w UI", () => {
  test("łączy się z /ws z tokenem w podprotokole i podaje migawki tematu słuchaczom", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    expect(sockets.opened.map(({ url, protocols }) => ({ url, protocols }))).toEqual([
      { url: "ws://127.0.0.1:4100/ws", protocols: ["trackwall.events", "bearer.sekret"] },
    ]);
    const feed = events.feed("sessions.changed");
    const received: SessionList[] = [];
    feed.subscribe((list) => received.push(list));
    expect(feed.isLive()).toBe(false);

    sockets.open();
    sockets.message(JSON.stringify({ type: "mise.running.changed", payload: [] }));
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: LIST }));
    expect(received).toEqual([LIST]);
    expect(feed.isLive()).toBe(true);
    events.close();
  });

  test("słuchacz zapisany później dostaje od razu ostatnią migawkę z bieżącego połączenia", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: LIST }));
    const received: SessionList[] = [];
    events.feed("sessions.changed").subscribe((list) => received.push(list));
    expect(received).toEqual([LIST]);
    events.close();
  });

  test("ramka niezgodna z kontraktem jest pomijana, a temat zostaje na odpytywaniu", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    const feed = events.feed("sessions.changed");
    const received: SessionList[] = [];
    feed.subscribe((list) => received.push(list));
    sockets.message("nie json");
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: { sessions: "?" } }));
    sockets.message(JSON.stringify({ type: "nowy.temat", payload: {} }));
    expect(received).toEqual([]);
    expect(feed.isLive()).toBe(false);
    events.close();
  });

  test("po zerwaniu temat przestaje być na żywo, a klient łączy się ponownie po przerwie", async () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    const feed = events.feed("sessions.changed");
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: LIST }));
    sockets.close();
    expect(feed.isLive()).toBe(false);
    expect(sockets.opened).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(sockets.opened).toHaveLength(2);
    events.close();
  });

  test("zamknięty klient nie łączy się ponownie", async () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    events.close();
    sockets.close();
    await new Promise((r) => setTimeout(r, 1100));
    expect(sockets.opened).toHaveLength(1);
  });
});

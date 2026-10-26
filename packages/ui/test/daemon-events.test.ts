import { describe, expect, test } from "bun:test";
import type { SessionList } from "@trackwall/protocol";
import { DaemonEvents, type EventSocket } from "../src/lib/daemon-events.ts";

const LIST: SessionList = { sessions: [], tasks: [], proposals: [], messages: [] };

/** A fake browser WebSocket: the test itself opens the connection, sends frames and closes it. */
function fakeSockets() {
  const opened: { url: string; protocols: string[]; socket: EventSocket }[] = [];
  const openSocket = (url: string, protocols: string[]) => {
    const socket = { onopen: null, onmessage: null, onclose: null, close: () => {} } as unknown as EventSocket;
    opened.push({ url, protocols, socket });
    return socket;
  };
  const last = () => {
    const entry = opened.at(-1);
    if (!entry) throw new Error("no connection");
    return entry.socket;
  };
  const message = (data: unknown) => last().onmessage?.call(last() as WebSocket, new MessageEvent("message", { data }));
  const open = () => last().onopen?.call(last() as WebSocket, new Event("open"));
  const close = () => last().onclose?.call(last() as WebSocket, new CloseEvent("close"));
  return { opened, openSocket, message, open, close };
}

function makeEvents(sockets: ReturnType<typeof fakeSockets>) {
  return new DaemonEvents({
    conn: { baseUrl: "http://127.0.0.1:4100", token: "secret" },
    location: { protocol: "tauri:", host: "localhost" },
    openSocket: sockets.openSocket,
  });
}

describe("daemon events in the UI", () => {
  test("connects to /ws with the token in the subprotocol and passes topic snapshots to listeners", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    expect(sockets.opened.map(({ url, protocols }) => ({ url, protocols }))).toEqual([
      { url: "ws://127.0.0.1:4100/ws", protocols: ["trackwall.events", "bearer.secret"] },
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

  test("a listener subscribed later at once gets the latest snapshot from the current connection", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: LIST }));
    const received: SessionList[] = [];
    events.feed("sessions.changed").subscribe((list) => received.push(list));
    expect(received).toEqual([LIST]);
    events.close();
  });

  test("a frame outside the contract is skipped, and the topic stays on polling", () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    const feed = events.feed("sessions.changed");
    const received: SessionList[] = [];
    feed.subscribe((list) => received.push(list));
    sockets.message("not json");
    sockets.message(JSON.stringify({ type: "sessions.changed", payload: { sessions: "?" } }));
    sockets.message(JSON.stringify({ type: "new.topic", payload: {} }));
    expect(received).toEqual([]);
    expect(feed.isLive()).toBe(false);
    events.close();
  });

  test("after a disconnect the topic is no longer live, and the client reconnects after a pause", async () => {
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

  test("a closed client does not reconnect", async () => {
    const sockets = fakeSockets();
    const events = makeEvents(sockets);
    events.close();
    sockets.close();
    await new Promise((r) => setTimeout(r, 1100));
    expect(sockets.opened).toHaveLength(1);
  });
});

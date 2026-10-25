import { describe, expect, test } from "bun:test";
import { EVENTS_SOCKET, ptySocket } from "@trackwall/protocol";
import { daemonSocket } from "../src/lib/daemon-socket.ts";

const id = "6f1c1f2e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";

describe("daemon WebSocket address", () => {
  test("a Tauri window connects to the daemon directly, with the token in the subprotocol, not in the address", () => {
    const socket = daemonSocket({ baseUrl: "http://127.0.0.1:4100", token: "sekret" }, ptySocket(id), {
      protocol: "tauri:",
      host: "localhost",
    });
    expect(socket).toEqual({ url: `ws://127.0.0.1:4100/ws/pty/${id}`, protocols: ["trackwall.pty", "bearer.sekret"] });
  });

  test("the page served by the daemon and vite dev connect to their own address; without a token the Vite proxy adds it", () => {
    expect(daemonSocket({ baseUrl: "", token: "t" }, EVENTS_SOCKET, { protocol: "http:", host: "127.0.0.1:4100" })).toEqual({
      url: "ws://127.0.0.1:4100/ws",
      protocols: ["trackwall.events", "bearer.t"],
    });
    expect(daemonSocket({ baseUrl: "" }, EVENTS_SOCKET, { protocol: "http:", host: "127.0.0.1:5173" }).protocols).toEqual([
      "trackwall.events",
    ]);
  });
});

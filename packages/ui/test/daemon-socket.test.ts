import { describe, expect, test } from "bun:test";
import { daemonSocket } from "../src/lib/daemon-socket.ts";

const id = "6f1c1f2e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";

describe("adres WebSocketu daemona", () => {
  test("okno Tauri łączy się z daemonem wprost, z tokenem w podprotokole, nie w adresie", () => {
    const socket = daemonSocket({ baseUrl: "http://127.0.0.1:4100", token: "sekret" }, `/ws/pty/${id}`, "trackwall.pty", {
      protocol: "tauri:",
      host: "localhost",
    });
    expect(socket).toEqual({ url: `ws://127.0.0.1:4100/ws/pty/${id}`, protocols: ["trackwall.pty", "bearer.sekret"] });
  });

  test("strona z daemona i vite dev łączą się z własnym adresem; bez tokenu dokłada go proxy Vite", () => {
    expect(daemonSocket({ baseUrl: "", token: "t" }, "/ws", "trackwall.events", { protocol: "http:", host: "127.0.0.1:4100" })).toEqual({
      url: "ws://127.0.0.1:4100/ws",
      protocols: ["trackwall.events", "bearer.t"],
    });
    expect(daemonSocket({ baseUrl: "" }, "/ws", "trackwall.events", { protocol: "http:", host: "127.0.0.1:5173" }).protocols).toEqual([
      "trackwall.events",
    ]);
  });
});

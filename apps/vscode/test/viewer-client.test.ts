import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ViewerSessionList } from "@trackwall/protocol";
import { readSessions } from "../src/viewer-client.ts";
import { notSharingMessage, stateFolder } from "../src/viewer-file.ts";

const TOKEN = "k".repeat(43);
const LIST: ViewerSessionList = {
  sessions: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      place: "shop",
      supervisor: false,
      windowTitle: null,
      task: null,
      taskName: null,
      status: { tone: "warning", label: "asking for approval" },
      needsAttention: true,
      live: true,
      since: "2026-11-07T10:00:00Z",
    },
  ],
  proposals: 1,
};

/** A daemon of one start: `/api/health` with its instance, and the viewer's list for the viewer token alone. */
let server: Server;
let port: number;
const tokensSent: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health")
        return void res.end(JSON.stringify({ ok: true, data: { status: "ok", version: "1", instance: "start-1" } }));
      tokensSent.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return void res.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "missing or invalid token" } }));
      }
      res.end(JSON.stringify({ ok: true, data: LIST }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function folderWith(viewerJson: string | undefined): string {
  const folder = mkdtempSync(join(tmpdir(), "trackwall-vscode-"));
  if (viewerJson !== undefined) writeFileSync(join(folder, "viewer.json"), viewerJson);
  return folder;
}

describe("one look at the daemon", () => {
  test("without viewer.json viewer access is off and nothing is sent", async () => {
    const before = tokensSent.length;
    expect(await readSessions(folderWith(undefined))).toEqual({ kind: "off" });
    expect(tokensSent).toHaveLength(before);
  });

  test("with viewer.json of the running daemon start it gets the session list", async () => {
    const folder = folderWith(JSON.stringify({ port, token: TOKEN, instance: "start-1" }));
    expect(await readSessions(folder)).toEqual({ kind: "connected", list: LIST });
  });

  test("a viewer.json of an earlier start never sends its token to whatever listens on the port now", async () => {
    const before = tokensSent.length;
    const folder = folderWith(JSON.stringify({ port, token: TOKEN, instance: "start-0" }));
    expect(await readSessions(folder)).toEqual({ kind: "unavailable", reason: "Trackwall that wrote viewer.json is not running any more" });
    expect(tokensSent).toHaveLength(before);
  });

  test("a refused token says why", async () => {
    const folder = folderWith(JSON.stringify({ port, token: "z".repeat(43), instance: "start-1" }));
    expect(await readSessions(folder)).toEqual({ kind: "unavailable", reason: "missing or invalid token" });
  });

  test("a viewer.json of a Trackwall that has stopped says so in plain words", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const folder = folderWith(JSON.stringify({ port: free, token: TOKEN, instance: "start-1" }));
    expect(await readSessions(folder)).toEqual({ kind: "unavailable", reason: "Trackwall is not running" });
  });

  test("a damaged viewer.json is unavailable, not off", async () => {
    expect(await readSessions(folderWith("{ not json"))).toEqual({ kind: "unavailable", reason: "viewer.json is not JSON" });
    expect(await readSessions(folderWith(JSON.stringify({ port: "x" })))).toEqual({
      kind: "unavailable",
      reason: "viewer.json is not what Trackwall writes",
    });
  });
});

describe("Trackwall's state folder", () => {
  test("is the setting first, then TRACKWALL_HOME, then .trackwall in the home folder, as the daemon picks it", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    expect(stateFolder(` ${home} `, { TRACKWALL_HOME: "/elsewhere" })).toEqual({ path: home, ignoredSetting: null });
    expect(stateFolder("", { TRACKWALL_HOME: home })).toEqual({ path: home, ignoredSetting: null });
    expect(stateFolder("", {}).path).toEndWith(".trackwall");
  });
});

describe("Trackwall's state folder set on another computer", () => {
  test("is ignored when it does not exist here, and the folder comes from TRACKWALL_HOME as without the setting", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const fromHost = join(tmpdir(), "no-such-folder", "Users", "someone", ".trackwall");
    expect(stateFolder(fromHost, { TRACKWALL_HOME: home })).toEqual({ path: home, ignoredSetting: resolve(fromHost) });
  });

  test("is named in the side bar's text with the viewer.json the extension looked for", () => {
    const fromHost = join(tmpdir(), "no-such-folder", "Users", "someone", ".trackwall");
    const inContainer = join(tmpdir(), "container-home", ".trackwall");
    expect(notSharingMessage({ path: inContainer, ignoredSetting: fromHost })).toBe(
      `Trackwall is not sharing its sessions with VS Code yet: there is no ${join(inContainer, "viewer.json")}.` +
        ` "Trackwall: State Folder" is ${fromHost}, which does not exist on this machine, so it is ignored here.` +
        ` Turn on "VS Code extension" in Trackwall's Settings > App. This side bar fills in a few seconds later.`,
    );
    expect(notSharingMessage({ path: inContainer, ignoredSetting: null })).toBe(
      `Trackwall is not sharing its sessions with VS Code yet: there is no ${join(inContainer, "viewer.json")}.` +
        ` Turn on "VS Code extension" in Trackwall's Settings > App. This side bar fills in a few seconds later.`,
    );
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ApiEnvelope,
  agentsApi,
  EVENTS_SOCKET,
  HealthResult,
  VIEWER_FILE,
  ViewerAccessState,
  ViewerFile,
  ViewerSessionList,
  viewerApi,
} from "@trackwall/protocol";
import WebSocket from "ws";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { ViewerAccess } from "../src/modules/viewer-access/viewer-access.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "v".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

const viewerFile = () => join(daemon.home, VIEWER_FILE);
const readViewerFile = () => ViewerFile.parse(JSON.parse(readFileSync(viewerFile(), "utf8")));
const post = (path: string, token: string, body = "{}") => loopbackRequest(daemon.api.port, path, { method: "POST", token, body });

async function viewerSessions(token: string): Promise<ViewerSessionList> {
  const res = await post(viewerApi.sessions.path, token);
  expect(res.status).toBe(200);
  const result = ApiEnvelope.parse(JSON.parse(res.body));
  if (!result.ok) throw new Error(result.error.message);
  return ViewerSessionList.parse(result.data);
}

/** Whether the events WebSocket opens with `token`; the daemon refuses an upgrade it does not accept before any frame. */
function eventsOpen(token: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}${EVENTS_SOCKET.path}`, [EVENTS_SOCKET.subprotocol, `bearer.${token}`]);
  return new Promise((resolve) => {
    ws.once("open", () => {
      ws.close();
      resolve(true);
    });
    ws.once("unexpected-response", () => resolve(false));
    ws.once("error", () => resolve(false));
  });
}

describe.skipIf(process.versions.bun === undefined)("viewer access for the VS Code extension", () => {
  test("is off until the user turns it on: no viewer.json and no token but the daemon's opens the viewer's session list", async () => {
    expect(existsSync(viewerFile())).toBe(false);
    expect(await daemon.post(viewerApi.state, {})).toEqual({ enabled: false, file: viewerFile() });
    expect((await post(viewerApi.sessions.path, "x".repeat(43))).status).toBe(401);
    expect(await viewerSessions(TOKEN)).toEqual({ sessions: [], proposals: 0 });
  });

  test("turning it on writes the port, a new token and this daemon start, for the user only", async () => {
    expect(ViewerAccessState.parse(await daemon.post(viewerApi.setEnabled, { enabled: true })).enabled).toBe(true);
    const file = readViewerFile();
    const health = HealthResult.parse(JSON.parse((await loopbackRequest(daemon.api.port, "/api/health")).body));
    expect(file.port).toBe(daemon.api.port);
    expect(file.instance).toBe(health.ok ? (health.data.instance ?? "") : "");
    expect(file.token).not.toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(viewerFile()).mode & 0o777).toBe(0o600);
  });

  test(
    "the viewer token shows a running session in the UI's words and only the fields a glance needs",
    async () => {
      const session = await daemon.post(agentsApi.start, { repo: "shop" });
      const { token } = readViewerFile();
      const deadline = Date.now() + 15_000;
      let list = await viewerSessions(token);
      while (list.sessions[0]?.needsAttention !== true && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        list = await viewerSessions(token);
      }
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0]).toMatchObject({
        id: session.id,
        place: "shop",
        supervisor: false,
        task: null,
        taskName: null,
        status: { tone: "warning", label: expect.stringContaining("waiting for you") },
        needsAttention: true,
        live: true,
      });
      expect(Object.keys(list.sessions[0] ?? {}).sort()).toEqual(
        ["id", "live", "needsAttention", "place", "since", "status", "supervisor", "task", "taskName", "windowTitle"].sort(),
      );
      await daemon.post(agentsApi.stop, { session: session.id });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("the viewer token opens nothing else: no other action, no MCP, no hooks, no WebSocket", async () => {
    const { token } = readViewerFile();
    for (const path of [
      agentsApi.sessions.path,
      viewerApi.state.path,
      viewerApi.setEnabled.path,
      "/api/daemon/shutdown",
      "/mcp",
      "/hooks/agentStop",
    ]) {
      expect({ path, status: (await post(path, token)).status }).toEqual({ path, status: 401 });
    }
    expect((await loopbackRequest(daemon.api.port, "/api/daemon/info", { token })).status).toBe(401);
    expect(await eventsOpen(token)).toBe(false);
    expect(await eventsOpen(TOKEN)).toBe(true);
  });

  test("a viewer request from a page in a browser is refused by its Origin like any other", async () => {
    const { token } = readViewerFile();
    const res = await loopbackRequest(daemon.api.port, viewerApi.sessions.path, {
      method: "POST",
      token,
      body: "{}",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("the next daemon start issues a new token into the file, and the old one stops working", async () => {
    const old = readViewerFile().token;
    // What the next start's facade does once its API listens; here it shares this API's port, so only the token changes.
    const next = new ViewerAccess({ home: daemon.home, log: () => {} });
    next.open({ port: daemon.api.port, instance: "next-start" });
    const file = readViewerFile();
    expect(file.instance).toBe("next-start");
    expect(file.token).not.toBe(old);
    expect(next.accepts(file.token)).toBe(true);
    expect(next.accepts(old)).toBe(false);
  });

  test("turning it off removes the file and refuses the token at once", async () => {
    await daemon.post(viewerApi.setEnabled, { enabled: true });
    const { token } = readViewerFile();
    expect((await viewerSessions(token)).proposals).toBe(0);
    expect(await daemon.post(viewerApi.setEnabled, { enabled: false })).toEqual({ enabled: false, file: viewerFile() });
    expect(existsSync(viewerFile())).toBe(false);
    expect((await post(viewerApi.sessions.path, token)).status).toBe(401);
  });

  test("a daemon start without viewer.json leaves viewer access off", () => {
    const next = new ViewerAccess({ home: daemon.home, log: () => {} });
    next.open({ port: daemon.api.port, instance: "later" });
    expect(next.state().enabled).toBe(false);
    expect(existsSync(viewerFile())).toBe(false);
  });
});

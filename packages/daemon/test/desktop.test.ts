import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonInfoResult, workspaceApi } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { desktopOpeners, hasDesktop } from "../src/infra/desktop.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { createMcpEndpoint } from "../src/mcp/endpoint.ts";
import { makeRepo } from "./support/git-repo.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

describe("hasDesktop", () => {
  const nothing = () => false;

  test("Windows and macOS always have a desktop", () => {
    expect(hasDesktop({ platform: "win32", env: {}, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "darwin", env: {}, exists: nothing })).toBe(true);
  });

  test("Linux has a desktop when a graphical session is there", () => {
    expect(hasDesktop({ platform: "linux", env: { DISPLAY: ":0" }, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, exists: nothing })).toBe(true);
    expect(hasDesktop({ platform: "linux", env: {}, exists: nothing })).toBe(false);
  });

  test("a Docker or Podman container has no desktop, even with a display socket of the host", () => {
    const docker = (path: string) => path === "/.dockerenv";
    const podman = (path: string) => path === "/run/.containerenv";
    expect(hasDesktop({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, exists: docker })).toBe(false);
    expect(hasDesktop({ platform: "linux", env: { DISPLAY: ":0" }, exists: podman })).toBe(false);
  });
});

describe("a daemon without a desktop", () => {
  const TOKEN = "t".repeat(43);
  const openedUrls: string[] = [];
  const openedFolders: string[] = [];
  let api: ApiServer;

  beforeAll(async () => {
    const openers = desktopOpeners(false, { openUrl: (url) => openedUrls.push(url), openFolder: (dir) => openedFolders.push(dir) });
    const facade = createFacade({
      home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
      homeFrom: "flag",
      openUrl: openers.openUrl,
      openFolder: openers.openFolder,
      miseCommand: ["mise"],
      copilotCommand: ["copilot"],
      version: "0.0.0-test",
      sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
      sessionMcpServer: (sessionToken) => ({ url: "http://127.0.0.1:9/mcp", headers: { "x-trackwall-session-token": sessionToken } }),
      hostingClis: HOSTING_CLIS,
      userEnv: async () => process.env,
      log: () => {},
    });
    api = await startApi({
      token: TOKEN,
      version: "9.9.9",
      info: () => ({
        version: "9.9.9",
        pid: 1,
        startedAt: "2026-10-29T00:00:00Z",
        uptimeMs: 0,
        platform: "linux",
        arch: "x64",
        runtime: { name: "bun", version: "x" },
        launchedBy: "manual",
        home: "/tmp",
        mcpStdioCommand: ["trackwall-daemon", "mcp-stdio"],
        desktop: false,
      }),
      onShutdown: () => {},
      facade,
      mcp: createMcpEndpoint({ facade, version: "test", log: () => {} }),
      events: new EventHub({ facade, log: () => {} }),
    });
  }, SLOW_TEST_TIMEOUT_MS);

  afterAll(() => api.close());

  const post = (path: string, body: unknown) =>
    loopbackRequest(api.port, path, {
      token: TOKEN,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("says so in its info, so the page opens web links itself", async () => {
    const res = await loopbackRequest(api.port, "/api/daemon/info", { token: TOKEN });
    expect(DaemonInfoResult.parse(JSON.parse(res.body))).toMatchObject({ ok: true, data: { desktop: false } });
  });

  test("refuses to open a link, a repo folder or VS Code with no_desktop instead of failing unseen", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    makeRepo({ "a.txt": "1" }, "shop", projects);
    expect((await post(workspaceApi.setProjectsDir.path, { path: projects })).status).toBe(200);

    for (const [path, body] of [
      [workspaceApi.openLink.path, { url: "https://example.com/docs" }],
      [workspaceApi.openFolder.path, { repo: "shop" }],
      [workspaceApi.openEditor.path, { repo: "shop" }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: { code: "no_desktop", message: expect.stringContaining("container") },
      });
    }
    expect(openedUrls).toEqual([]);
    expect(openedFolders).toEqual([]);
  });
});

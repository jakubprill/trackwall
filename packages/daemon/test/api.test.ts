import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiResult,
  BatchRun,
  batchApi,
  cardsApi,
  DaemonInfoResult,
  graphApi,
  HealthResult,
  LogTail,
  localConfigApi,
  logsApi,
  MAX_REPOS_PER_REQUEST,
  miseApi,
  Repo,
  RepoGraph,
  RepoList,
  workspaceApi,
} from "@trackwall/protocol";
import { z } from "zod";
import { EventHub } from "../src/api/event-hub.ts";
import { postRoutes } from "../src/api/routes.ts";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { type LoopbackOptions, loopbackRequest } from "../src/infra/loopback.ts";
import { createMcpEndpoint } from "../src/mcp/endpoint.ts";
import { makeRepo } from "./support/git-repo.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
let api: ApiServer;
let shutdowns = 0;

beforeAll(async () => {
  // A parent directory named `assets` checks that caching depends on the path relative to the UI, not the whole path.
  const parent = join(mkdtempSync(join(tmpdir(), "trackwall-ui-")), "assets");
  const uiDir = join(parent, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>trackwall</title>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
  // A file right next to the UI directory: the target of attempts to leave the directory in the path traversal test.
  writeFileSync(join(parent, "trackwall-secret.txt"), "not to be read");
  api = await startApi({
    token: TOKEN,
    version: "9.9.9",
    uiDir,
    info: () => ({
      version: "9.9.9",
      pid: 1,
      startedAt: "2026-10-23T00:00:00Z",
      uptimeMs: 0,
      platform: "test",
      arch: "test",
      runtime: { name: "bun", version: "x" },
      launchedBy: "manual",
      home: "/tmp",
      mcpStdioCommand: ["trackwall-daemon", "mcp-stdio"],
      desktop: true,
      container: null,
      devContainerFolder: null,
    }),
    onShutdown: () => {
      shutdowns++;
    },
    ...modules(),
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => api.close());

/** The addresses the daemon asked the system to open (`openUrl`), instead of a real browser. */
const openedUrls: string[] = [];
/** Folders the daemon asked the system to open (`openFolder`), instead of a real Explorer or Finder. */
const openedFolders: string[] = [];

/** A facade on an empty state directory, with the MCP server and events on it: what `main.ts` gives to `startApi`. */
function modules() {
  const facade = createFacade({
    home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
    homeFrom: "flag",
    openUrl: (url) => openedUrls.push(url),
    openFolder: (dir) => openedFolders.push(dir),
    miseCommand: ["mise"],
    copilotCommand: ["copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: (sessionToken) => ({ url: "http://127.0.0.1:9/mcp", headers: { "x-trackwall-session-token": sessionToken } }),
    hostingClis: HOSTING_CLIS,
    userEnv: async () => process.env,
    log: () => {},
  });
  return { facade, mcp: createMcpEndpoint({ facade, version: "test", log: () => {} }), events: new EventHub({ facade, log: () => {} }) };
}

/** Requests through node:http: it can set `Host` and does not go through HTTP_PROXY. */
const req = (path: string, opts: LoopbackOptions = {}) => loopbackRequest(api.port, path, opts);
const authed = (path: string, opts: LoopbackOptions = {}) => req(path, { token: TOKEN, ...opts });

describe("api", () => {
  test("health is public and returns the version", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    expect(HealthResult.parse(JSON.parse(res.body))).toEqual({ ok: true, data: { status: "ok", version: "9.9.9" } });
  });

  test("info requires the token", async () => {
    expect((await req("/api/daemon/info")).status).toBe(401);
    expect((await req("/api/daemon/info", { token: "x".repeat(43) })).status).toBe(401);
    expect((await req("/api/daemon/info", { token: "short" })).status).toBe(401);
    const res = await authed("/api/daemon/info");
    expect(res.status).toBe(200);
    expect(DaemonInfoResult.parse(JSON.parse(res.body)).ok).toBe(true);
  });

  test("a foreign Origin is rejected even with a valid token", async () => {
    expect((await authed("/api/daemon/info", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await authed("/api/daemon/info", { headers: { origin: "null" } })).status).toBe(403);
  });

  test("a Host outside loopback is rejected (DNS rebinding)", async () => {
    expect((await req("/api/health", { headers: { host: `evil.example:${api.port}` } })).status).toBe(403);
    expect((await req("/api/health", { headers: { host: `localhost:${api.port}` } })).status).toBe(200);
    expect((await req("/api/health", { headers: { host: "127.0.0.1:1" } })).status).toBe(403);
  });

  test("the Tauri window gets CORS headers and preflight", async () => {
    const pre = await req("/api/daemon/info", {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost", "access-control-request-headers": "authorization" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    expect(pre.headers["access-control-allow-headers"]).toContain("authorization");
    const res = await authed("/api/daemon/info", { headers: { origin: "tauri://localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });

  test("the daemon's own page gets no CORS, because it is same-origin", async () => {
    const res = await req("/api/health", { headers: { origin: `http://127.0.0.1:${api.port}` } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("UI: index, assets, SPA fallback and no way out of the directory", async () => {
    const index = await req("/");
    expect(index.body).toContain("trackwall");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect((await req("/tasks/123")).body).toContain("trackwall");
    const asset = await req("/assets/app.js");
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await req("/assets/missing.js")).status).toBe(404);
    for (const path of [
      "/..%2ftrackwall-secret.txt",
      "/%2e%2e/trackwall-secret.txt",
      "/..%5ctrackwall-secret.txt",
      "/assets/..%2f..%2ftrackwall-secret.txt",
    ]) {
      const res = await req(path);
      expect({ path, status: res.status, leaked: res.body.includes("not to be read") }).toEqual({ path, status: 404, leaked: false });
    }
  });

  test("an unknown API route is 404 in the error envelope", async () => {
    const res = await authed("/api/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("shutdown answers, then triggers the stop", async () => {
    const res = await authed("/api/daemon/shutdown", { method: "POST" });
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { stopping: true } });
    await Bun.sleep(20);
    expect(shutdowns).toBe(1);
  });
});

describe("api workspace", () => {
  const post = (path: string, body: string) => authed(path, { method: "POST", headers: { "content-type": "application/json" }, body });

  test("every action of the workspace, cards, graph, local config, mise and batch contracts has a route in the daemon", () => {
    const endpoints = [
      ...Object.values(workspaceApi),
      ...Object.values(cardsApi),
      ...Object.values(graphApi),
      ...Object.values(localConfigApi),
      ...Object.values(miseApi),
      ...Object.values(batchApi),
    ];
    expect(endpoints.filter((endpoint) => !postRoutes.has(endpoint.path))).toEqual([]);
  });

  test("workspace routes require the token", async () => {
    expect((await req(workspaceApi.list.path, { method: "POST" })).status).toBe(401);
  });

  test("after the projects folder is set, its repos are on the list with their state from git", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    makeRepo({ "a.txt": "1" }, "shop", projects);
    const set = await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: projects }));
    expect(set.status).toBe(200);

    const list = apiResult(RepoList).parse(JSON.parse((await post(workspaceApi.list.path, "")).body));
    expect(list.ok && list.data.repos.map((r) => [r.id, r.status.kind])).toEqual([["shop", "ok"]]);

    const graph = apiResult(RepoGraph).parse(JSON.parse((await post(graphApi.graph.path, "")).body));
    expect(graph.ok && graph.data.nodes.map((n) => n.repo)).toEqual(["shop"]);
  });

  test("the quick list names the repos without their state, and repos gives the state of those asked, in that order (ADR-113)", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    makeRepo({ "a.txt": "1" }, "shop", projects);
    makeRepo({ "a.txt": "1" }, "api", projects);
    expect((await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: projects }))).status).toBe(200);

    const entries = apiResult(RepoList).parse(JSON.parse((await post(workspaceApi.entries.path, "")).body));
    expect(entries.ok && entries.data.repos.map((r) => [r.id, r.status.kind])).toEqual([
      ["api", "loading"],
      ["shop", "loading"],
    ]);

    const repos = apiResult(z.array(Repo)).parse(
      JSON.parse((await post(workspaceApi.repos.path, JSON.stringify({ repos: ["shop", "gone", "api"] }))).body),
    );
    expect(repos.ok && repos.data.map((r) => [r.id, r.status.kind])).toEqual([
      ["shop", "ok"],
      ["api", "ok"],
    ]);
  });

  test("repos refuses an empty request and one over the limit", async () => {
    expect((await post(workspaceApi.repos.path, JSON.stringify({ repos: [] }))).status).toBe(400);
    const tooMany = Array.from({ length: MAX_REPOS_PER_REQUEST + 1 }, (_, i) => `repo-${i}`);
    expect((await post(workspaceApi.repos.path, JSON.stringify({ repos: tooMany }))).status).toBe(400);
  });

  test("open-folder opens the folder of a listed repo in the system, and an unknown repo is 404", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    makeRepo({ "a.txt": "1" }, "shop", projects);
    expect((await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: projects }))).status).toBe(200);
    openedFolders.length = 0;

    expect((await post(workspaceApi.openFolder.path, JSON.stringify({ repo: "shop" }))).status).toBe(200);
    expect((await post(workspaceApi.openFolder.path, JSON.stringify({ repo: "missing" }))).status).toBe(404);

    expect(openedFolders).toEqual([join(projects, "shop")]);
  });

  test("a projects folder that does not exist is 400 with a description", async () => {
    const res = await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: join(tmpdir(), "trackwall-no-such-folder") }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      error: { code: "bad_request", message: expect.stringContaining("does not exist") },
    });
  });

  test("a body that does not match the schema or is not JSON is 400 with a description", async () => {
    const bad = await post(workspaceApi.tree.path, JSON.stringify({ repo: "shop", path: "../outside" }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false, error: { code: "bad_request", message: expect.stringContaining("..") } });
    expect((await post(workspaceApi.setProjectsDir.path, "{not json")).status).toBe(400);
  });

  test("a body larger than 64 KB is rejected before parsing", async () => {
    const res = await post(workspaceApi.list.path, JSON.stringify({ tooLarge: "x".repeat(70_000) }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("larger than") } });
  });

  test("a link from a README opens in the system only as a web page, in canonical form", async () => {
    openedUrls.length = 0;
    for (const url of ["https://example.com/docs?a=1#b", 'https://example.com/a b"c', "https://example.com\\..\\x"]) {
      expect((await post(workspaceApi.openLink.path, JSON.stringify({ url }))).status).toBe(200);
    }
    const rejected = ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "mailto:a@example.com?attach=id_rsa", "docs/a.md"];
    for (const url of rejected) {
      expect((await post(workspaceApi.openLink.path, JSON.stringify({ url }))).status).toBe(400);
    }
    expect(openedUrls).toEqual(["https://example.com/docs?a=1#b", "https://example.com/a%20b%22c", "https://example.com/x"]);
  });

  test("an unknown repo is 404, and GET on a POST route does not exist", async () => {
    const res = await post(workspaceApi.overview.path, JSON.stringify({ repo: "missing" }));
    expect(res.status).toBe(404);
    expect((await authed(workspaceApi.list.path)).status).toBe(404);
  });

  test("a batch command without repos or with an unknown step is 400, with an unknown repo 404, and none starts", async () => {
    const noRepos = await post(batchApi.start.path, JSON.stringify({ repos: [], steps: ["build"] }));
    expect(noRepos.status).toBe(400);
    expect(JSON.parse(noRepos.body)).toMatchObject({ error: { message: expect.stringContaining("at least one repo") } });
    expect((await post(batchApi.start.path, JSON.stringify({ repos: ["shop"], steps: ["deploy"] }))).status).toBe(400);
    expect((await post(batchApi.start.path, JSON.stringify({ repos: ["missing"], steps: ["build"] }))).status).toBe(404);

    const last = apiResult(BatchRun.nullable()).parse(JSON.parse((await post(batchApi.run.path, "")).body));
    expect(last).toEqual({ ok: true, data: null });
  });

  test("a clone with a name that would be a gh or glab option is 400 before the program even starts", async () => {
    const res = await post(
      workspaceApi.clone.path,
      JSON.stringify({ host: { kind: "gitlab", host: "gitlab.example.com" }, fullName: "--upload-pack=x/y" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("api logs", () => {
  const post = (path: string, body: unknown) =>
    authed(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("every action of the mise and logs contracts has a route in the daemon", () => {
    expect([...Object.values(miseApi), ...Object.values(logsApi)].filter((endpoint) => !postRoutes.has(endpoint.path))).toEqual([]);
  });

  test("the log of a mise task that printed nothing is empty, and a source that does not match the schema is 400", async () => {
    const source = { kind: "mise-task", repo: "web", miseTask: "dev" };
    const empty = await post(logsApi.tail.path, { source, limit: 100 });
    expect(apiResult(LogTail).parse(JSON.parse(empty.body))).toMatchObject({ ok: true, data: { records: [], dropped: false } });

    const bad = await post(logsApi.tail.path, { source: { ...source, miseTask: "--help" }, limit: 100 });
    expect(bad.status).toBe(400);
    expect((await post(logsApi.tail.path, { source, limit: 100_000 })).status).toBe(400);
  });
});

describe("--allow-origin", () => {
  test("an extra origin gets access and CORS, others do not", async () => {
    const extra = await startApi({
      token: TOKEN,
      version: "1",
      allowOrigins: ["http://127.0.0.1:5173"],
      info: () => {
        throw new Error("unused");
      },
      onShutdown: () => {},
      ...modules(),
    });
    try {
      const res = await loopbackRequest(extra.port, "/api/health", { headers: { origin: "http://127.0.0.1:5173" } });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
      expect((await loopbackRequest(extra.port, "/api/health", { headers: { origin: "http://127.0.0.1:5174" } })).status).toBe(403);
    } finally {
      await extra.close();
    }
  });
});

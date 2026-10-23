import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiResult, BatchRun, batchApi, DaemonInfoResult, HealthResult, miseApi, RepoList, workspaceApi } from "@trackwall/protocol";
import { postRoutes } from "../src/api/routes.ts";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade } from "../src/facade.ts";
import { type LoopbackOptions, loopbackRequest } from "../src/loopback.ts";
import { makeRepo } from "./support/git-repo.ts";

const TOKEN = "t".repeat(43);
let api: ApiServer;
let shutdowns = 0;

beforeAll(async () => {
  // Katalog nadrzędny o nazwie `assets` sprawdza, że cache zależy od ścieżki względem UI, nie całej ścieżki.
  const parent = join(mkdtempSync(join(tmpdir(), "trackwall-ui-")), "assets");
  const uiDir = join(parent, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>trackwall</title>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
  // Plik tuż obok katalogu UI: cel prób wyjścia poza katalog w teście path traversal.
  writeFileSync(join(parent, "trackwall-secret.txt"), "nie do odczytu");
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
    }),
    onShutdown: () => {
      shutdowns++;
    },
    facade: createFacade({
      home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
      openUrl: () => {},
      miseCommand: ["mise"],
      userEnv: async () => process.env,
      log: () => {},
    }),
  });
});

afterAll(() => api.close());

/** Żądania przez node:http: pozwala ustawić `Host` i nie idzie przez HTTP_PROXY. */
const req = (path: string, opts: LoopbackOptions = {}) => loopbackRequest(api.port, path, opts);
const authed = (path: string, opts: LoopbackOptions = {}) => req(path, { token: TOKEN, ...opts });

describe("api", () => {
  test("health jest publiczne i zwraca wersję", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    expect(HealthResult.parse(JSON.parse(res.body))).toEqual({ ok: true, data: { status: "ok", version: "9.9.9" } });
  });

  test("info wymaga tokenu", async () => {
    expect((await req("/api/daemon/info")).status).toBe(401);
    expect((await req("/api/daemon/info", { token: "x".repeat(43) })).status).toBe(401);
    expect((await req("/api/daemon/info", { token: "krótki" })).status).toBe(401);
    const res = await authed("/api/daemon/info");
    expect(res.status).toBe(200);
    expect(DaemonInfoResult.parse(JSON.parse(res.body)).ok).toBe(true);
  });

  test("obcy Origin jest odrzucany nawet z poprawnym tokenem", async () => {
    expect((await authed("/api/daemon/info", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await authed("/api/daemon/info", { headers: { origin: "null" } })).status).toBe(403);
  });

  test("Host spoza loopbacku jest odrzucany (DNS rebinding)", async () => {
    expect((await req("/api/health", { headers: { host: `evil.example:${api.port}` } })).status).toBe(403);
    expect((await req("/api/health", { headers: { host: `localhost:${api.port}` } })).status).toBe(200);
    expect((await req("/api/health", { headers: { host: "127.0.0.1:1" } })).status).toBe(403);
  });

  test("okno Tauri dostaje nagłówki CORS i preflight", async () => {
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

  test("strona z daemona nie dostaje CORS, bo jest same-origin", async () => {
    const res = await req("/api/health", { headers: { origin: `http://127.0.0.1:${api.port}` } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("UI: index, assets, fallback SPA i brak wyjścia poza katalog", async () => {
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
      expect({ path, status: res.status, leaked: res.body.includes("nie do odczytu") }).toEqual({ path, status: 404, leaked: false });
    }
  });

  test("nieznana trasa API to 404 w kopercie błędu", async () => {
    const res = await authed("/api/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("shutdown odpowiada, a potem wywołuje zatrzymanie", async () => {
    const res = await authed("/api/daemon/shutdown", { method: "POST" });
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { stopping: true } });
    await Bun.sleep(20);
    expect(shutdowns).toBe(1);
  });
});

describe("api workspace", () => {
  const post = (path: string, body: string) => authed(path, { method: "POST", headers: { "content-type": "application/json" }, body });

  test("każda akcja z kontraktów workspace, mise i batch ma trasę w daemonie", () => {
    const endpoints = [...Object.values(workspaceApi), ...Object.values(miseApi), ...Object.values(batchApi)];
    expect(endpoints.filter((endpoint) => !postRoutes.has(endpoint.path))).toEqual([]);
  });

  test("trasy workspace wymagają tokenu", async () => {
    expect((await req(workspaceApi.list.path, { method: "POST" })).status).toBe(401);
  });

  test("po ustawieniu folderu z projektami jego repo są na liście ze stanem z gita", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
    makeRepo({ "a.txt": "1" }, "sklep", projects);
    const set = await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: projects }));
    expect(set.status).toBe(200);

    const list = apiResult(RepoList).parse(JSON.parse((await post(workspaceApi.list.path, "")).body));
    expect(list.ok && list.data.repos.map((r) => [r.id, r.status.kind])).toEqual([["sklep", "ok"]]);
  });

  test("nieistniejący folder z projektami to 400 z opisem", async () => {
    const res = await post(workspaceApi.setProjectsDir.path, JSON.stringify({ path: join(tmpdir(), "trackwall-nie-ma-takiego") }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      error: { code: "bad_request", message: expect.stringContaining("nie istnieje") },
    });
  });

  test("ciało niezgodne ze schematem albo niebędące JSON-em to 400 z opisem", async () => {
    const bad = await post(workspaceApi.tree.path, JSON.stringify({ repo: "sklep", path: "../poza" }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false, error: { code: "bad_request", message: expect.stringContaining("..") } });
    expect((await post(workspaceApi.setProjectsDir.path, "{nie json")).status).toBe(400);
  });

  test("ciało większe niż 64 KB jest odrzucane przed parsowaniem", async () => {
    const res = await post(workspaceApi.list.path, JSON.stringify({ zbyt: "x".repeat(70_000) }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("większe niż") } });
  });

  test("nieznane repo to 404, a GET na trasie POST nie istnieje", async () => {
    const res = await post(workspaceApi.overview.path, JSON.stringify({ repo: "nie-ma" }));
    expect(res.status).toBe(404);
    expect((await authed(workspaceApi.list.path)).status).toBe(404);
  });

  test("komenda zbiorcza bez repo albo z nieznanym krokiem to 400, a z nieznanym repo 404, i żadna nie startuje", async () => {
    const noRepos = await post(batchApi.start.path, JSON.stringify({ repos: [], steps: ["build"] }));
    expect(noRepos.status).toBe(400);
    expect(JSON.parse(noRepos.body)).toMatchObject({ error: { message: expect.stringContaining("co najmniej jedno repo") } });
    expect((await post(batchApi.start.path, JSON.stringify({ repos: ["sklep"], steps: ["deploy"] }))).status).toBe(400);
    expect((await post(batchApi.start.path, JSON.stringify({ repos: ["nie-ma"], steps: ["build"] }))).status).toBe(404);

    const last = apiResult(BatchRun.nullable()).parse(JSON.parse((await post(batchApi.run.path, "")).body));
    expect(last).toEqual({ ok: true, data: null });
  });

  test("klon z nazwą, która byłaby opcją gh albo glab, to 400 jeszcze przed uruchomieniem programu", async () => {
    const res = await post(
      workspaceApi.clone.path,
      JSON.stringify({ host: { kind: "gitlab", host: "gitlab.example.com" }, fullName: "--upload-pack=x/y" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("--allow-origin", () => {
  test("dodatkowy origin dostaje dostęp i CORS, inne nie", async () => {
    const extra = await startApi({
      token: TOKEN,
      version: "1",
      allowOrigins: ["http://127.0.0.1:5173"],
      info: () => {
        throw new Error("nieużywane");
      },
      onShutdown: () => {},
      facade: createFacade({
        home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
        openUrl: () => {},
        miseCommand: ["mise"],
        userEnv: async () => process.env,
        log: () => {},
      }),
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

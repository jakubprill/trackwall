import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonInfoResult, HealthResult } from "@pitwall/protocol";
import { type ApiServer, startApi } from "../src/api/server.ts";

const TOKEN = "t".repeat(43);
let api: ApiServer;
let shutdowns = 0;
let base: string;

beforeAll(async () => {
  const uiDir = mkdtempSync(join(tmpdir(), "pitwall-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>pitwall</title>");
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(tmpdir(), "pitwall-secret.txt"), "nie do odczytu");
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
  });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(() => api.close());

const auth = { authorization: `Bearer ${TOKEN}` };

/** fetch() nie pozwala ustawić nagłówka Host, więc dla tego testu surowe żądanie. */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: api.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("api", () => {
  test("health jest publiczne i zwraca wersję", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = HealthResult.parse(await res.json());
    expect(body).toEqual({ ok: true, data: { status: "ok", version: "9.9.9" } });
  });

  test("info wymaga tokenu", async () => {
    expect((await fetch(`${base}/api/daemon/info`)).status).toBe(401);
    expect((await fetch(`${base}/api/daemon/info`, { headers: { authorization: `Bearer ${"x".repeat(43)}` } })).status).toBe(401);
    const res = await fetch(`${base}/api/daemon/info`, { headers: auth });
    expect(res.status).toBe(200);
    expect(DaemonInfoResult.parse(await res.json()).ok).toBe(true);
  });

  test("obcy Origin jest odrzucany nawet z poprawnym tokenem", async () => {
    const res = await fetch(`${base}/api/daemon/info`, { headers: { ...auth, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  test("Host spoza loopbacku jest odrzucany (DNS rebinding)", async () => {
    expect(await rawGet("/api/health", { host: `evil.example:${api.port}` })).toBe(403);
    expect(await rawGet("/api/health", { host: `localhost:${api.port}` })).toBe(200);
  });

  test("okno Tauri dostaje nagłówki CORS i preflight", async () => {
    const pre = await fetch(`${base}/api/daemon/info`, {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost", "access-control-request-headers": "authorization" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const res = await fetch(`${base}/api/daemon/info`, { headers: { ...auth, origin: "tauri://localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
  });

  test("strona z daemona nie dostaje CORS, bo jest same-origin", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { origin: base } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("UI: index, assets, fallback SPA i brak wyjścia poza katalog", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("pitwall");
    expect(await (await fetch(`${base}/tasks/123`)).text()).toContain("pitwall");
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect(await rawGet("/..%2fpitwall-secret.txt", { host: `127.0.0.1:${api.port}` })).toBe(404);
    expect(await rawGet("/%2e%2e/%2e%2e/pitwall-secret.txt", { host: `127.0.0.1:${api.port}` })).toBe(404);
    expect(await rawGet("/..%5cpitwall-secret.txt", { host: `127.0.0.1:${api.port}` })).toBe(404);
  });

  test("nieznana trasa API to 404 w kopercie błędu", async () => {
    const res = await fetch(`${base}/api/nope`, { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("shutdown odpowiada, a potem wywołuje zatrzymanie", async () => {
    const res = await fetch(`${base}/api/daemon/shutdown`, { method: "POST", headers: auth });
    expect(await res.json()).toEqual({ ok: true, data: { stopping: true } });
    await Bun.sleep(20);
    expect(shutdowns).toBe(1);
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
    });
    try {
      const url = `http://127.0.0.1:${extra.port}/api/health`;
      const res = await fetch(url, { headers: { origin: "http://127.0.0.1:5173" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
      expect((await fetch(url, { headers: { origin: "http://127.0.0.1:5174" } })).status).toBe(403);
    } finally {
      await extra.close();
    }
  });
});

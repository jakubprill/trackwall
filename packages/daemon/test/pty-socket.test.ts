import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi, apiResult, PTY_CLOSE_NOT_FOUND, PTY_SUBPROTOCOL, Session, SessionList } from "@trackwall/protocol";
import WebSocket from "ws";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade, type Facade } from "../src/facade.ts";
import { loopbackRequest } from "../src/loopback.ts";
import { makeRepo } from "./support/git-repo.ts";

const TOKEN = "p".repeat(43);
const fakeCopilot = join(import.meta.dir, "fixtures", "fake-copilot-session.ts");
const daemonMain = join(import.meta.dir, "..", "src", "main.ts");
let api: ApiServer;
let facade: Facade;

beforeAll(async () => {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  makeRepo({ "README.md": "# sklep\n" }, "sklep", projects);
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
  facade = createFacade({
    home,
    openUrl: () => {},
    miseCommand: ["mise"],
    copilotCommand: [process.execPath, fakeCopilot],
    hookCommand: (event, hooksFile) => ({ exec: process.execPath, args: ["--no-env-file", daemonMain, "copilot-hook", event, hooksFile] }),
    userEnv: async () => process.env,
    log: () => {},
  });
  api = await startApi({
    token: TOKEN,
    version: "1",
    info: () => {
      throw new Error("nieużywane");
    },
    onShutdown: () => {},
    facade,
  });
});

afterAll(async () => {
  await facade.procs.stopAll();
  facade.agents.close();
  await api.close();
});

async function post<T>(path: string, body: unknown, data: { parse: (v: unknown) => T }): Promise<T> {
  const res = await loopbackRequest(api.port, path, { method: "POST", token: TOKEN, body: JSON.stringify(body), timeoutMs: 10_000 });
  const result = apiResult(Session.or(SessionList)).parse(JSON.parse(res.body));
  if (!result.ok) throw new Error(`${path}: ${result.error.message}`);
  return data.parse(result.data);
}

/** Klient terminala: zbiera obraz ekranu i wyjście jako tekst. */
function connect(session: string, protocols: string[], headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws/pty/${session}`, protocols, { headers });
  let text = "";
  ws.on("message", (data: Buffer) => {
    text += data.toString("utf8");
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, opened, closed, text: () => text };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`nie doczekano się: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("terminal sesji przez WebSocket", () => {
  test("okno dostaje ekran sesji, a klawisze i rozmiar trafiają do Copilot CLI", async () => {
    const session = await post(agentsApi.start.path, { repo: "sklep" }, Session);
    const client = connect(session.id, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]);
    await client.opened;
    expect(client.ws.protocol).toBe(PTY_SUBPROTOCOL);
    await until(() => client.text().includes("Witaj w atrapie"), "ekran powitalny");

    client.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    client.ws.send(JSON.stringify({ type: "input", data: "napraw build\r" }));
    await until(() => client.text().includes("Zezwolić na bash?"), "prośba o zgodę na ekranie");
    await until(async () => {
      const list = await post(agentsApi.sessions.path, {}, SessionList);
      return list.sessions.find((s) => s.id === session.id)?.state?.state === "Approval";
    }, "stan Approval z hooka");

    client.ws.close();
    await post(agentsApi.stop.path, { session: session.id }, Session);
  }, 60_000);

  test("bez tokenu, z obcym Origin albo do nieznanej sesji połączenie jest odrzucane", async () => {
    const session = "00000000-0000-4000-8000-000000000000";
    await expect(connect(session, [PTY_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect(session, [PTY_SUBPROTOCOL, `bearer.${"x".repeat(43)}`]).opened).rejects.toThrow("status 401");
    await expect(connect(session, [`bearer.${TOKEN}`]).opened).rejects.toThrow("status 401");
    await expect(connect(session, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`], { origin: "https://evil.example" }).opened).rejects.toThrow(
      "status 403",
    );
    await expect(connect("nie-uuid", [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]).opened).rejects.toThrow("status 404");

    const unknown = connect(session, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]);
    expect(await unknown.closed).toBe(PTY_CLOSE_NOT_FOUND);
  });

  test("żądanie z adresem, którego nie da się sparsować, dostaje 404, a daemon działa dalej", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(api.port, "127.0.0.1", () => {
        socket.write(`GET http://[x/ HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
    });
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
    const health = await loopbackRequest(api.port, "/api/health", { method: "GET", timeoutMs: 5000 });
    expect(health.status).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DaemonInfoResult, GetRepoResult, ListReposResult, workspaceApi } from "@trackwall/protocol";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { readDaemonFile, writeDaemonFile } from "../src/discovery.ts";
import { createFacade } from "../src/facade.ts";
import { loopbackRequest } from "../src/loopback.ts";
import { MCP_PATH } from "../src/mcp/endpoint.ts";
import { runStdioBridge } from "../src/mcp/stdio-bridge.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const TOKEN = "m".repeat(43);
const README = "# Zamówienia\n\nBFF sklepu.\n";
let api: ApiServer;
let projects: string;
let orders: string;
const logs: string[] = [];

beforeAll(async () => {
  projects = mkdtempSync(join(tmpdir(), "trackwall-mcp-projects-"));
  orders = makeRepo({ "README.md": README, "src/app.ts": "export {};\n" }, "orders-bff", projects);
  gitIn(orders, "remote", "add", "origin", "git@gitlab.example.com:sklep/orders-bff.git");
  const facade = createFacade({
    home: mkdtempSync(join(tmpdir(), "trackwall-mcp-home-")),
    openUrl: () => {},
    // Program, którego nie ma w PATH: lista tasków mise jest wtedy stanem `not_installed`, na każdej maszynie tak samo.
    miseCommand: ["trackwall-test-brak-mise"],
    userEnv: async () => process.env,
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  api = await startApi({
    token: TOKEN,
    version: "9.9.9",
    info: () => {
      throw new Error("nieużywane");
    },
    onShutdown: () => {},
    facade,
    log: (msg) => logs.push(msg),
  });
});

afterAll(() => api.close());

describe("serwer MCP przez Streamable HTTP", () => {
  test("ogłasza tylko narzędzia do odczytu: list_repos i get_repo", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_repos", "get_repo"]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(client.getServerVersion()).toMatchObject({ name: "trackwall", version: "9.9.9" });
    await client.close();
  });

  test("list_repos zwraca repo z folderu z projektami z adresem repo zdalnego i gałęzią", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "list_repos", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = ListReposResult.parse(result.structuredContent);
    expect(data.projectsDir).toBe(projects);
    expect(data.repos).toHaveLength(1);
    expect(data.repos[0]).toMatchObject({
      id: "orders-bff",
      path: orders,
      remote: "gitlab.example.com/sklep/orders-bff",
      status: { kind: "ok", branch: "main", changes: 0 },
      lastSync: null,
    });
    // Tekst wyniku to ten sam JSON dla klientów, które nie czytają `structuredContent`.
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(logs.some((l) => l.startsWith("[mcp] list_repos: ok"))).toBe(true);
    await client.close();
  });

  test("get_repo zwraca README, ostatnie commity i stan tasków mise", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "orders-bff" } });
    const data = GetRepoResult.parse(result.structuredContent);
    expect(data.repo.id).toBe("orders-bff");
    expect(data.readme).toEqual({ path: "README.md", text: README, truncated: false });
    expect(data.commits.map((c) => c.subject)).toEqual(["pierwszy commit"]);
    expect(data.miseTasks.kind).toBe("not_installed");
    await client.close();
  });

  test("get_repo z nieznanym repo zwraca błąd narzędzia z kodem, a nie błąd protokołu", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "nie-ma-takiego" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: 'not_found: w folderze z projektami nie ma repo "nie-ma-takiego"' }]);
    await client.close();
  });

  test("get_repo odrzuca identyfikator spoza schematu RepoId", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "../etc" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  test("klient z rewizją 2026-07-28 dostaje te same narzędzia", async () => {
    const client = await connectHttpClient(api.port, TOKEN, { mode: "auto" });
    const data = ListReposResult.parse((await client.callTool({ name: "list_repos", arguments: {} })).structuredContent);
    expect(data.repos.map((r) => r.id)).toEqual(["orders-bff"]);
    await client.close();
  });

  test("bez tokenu albo z obcym Origin daemon odrzuca żądanie przed MCP", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await loopbackRequest(api.port, MCP_PATH, { method: "POST", body, headers })).status).toBe(401);
    expect((await loopbackRequest(api.port, MCP_PATH, { method: "POST", body, headers, token: "x".repeat(43) })).status).toBe(401);
    const evil = { ...headers, origin: "https://evil.example" };
    expect((await loopbackRequest(api.port, MCP_PATH, { method: "POST", body, headers: evil, token: TOKEN })).status).toBe(403);
  });
});

/** Most w tym samym procesie: wiadomości jako linie na wejściu, odpowiedzi jako linie z wyjścia. */
async function throughBridge(home: string, messages: object[]): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  const done = runStdioBridge({ home, input, output, log: () => {} });
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
  input.end();
  await done;
  return lines.map((l) => JSON.parse(l));
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

describe("most stdio", () => {
  test("przekazuje initialize, powiadomienie i wywołanie narzędzia do daemona z daemon.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-bridge-"));
    writeDaemonFile(home, { pid: process.pid, port: api.port, token: TOKEN, startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
    const replies = await throughBridge(home, [
      INITIALIZE,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_repos", arguments: {} } },
    ]);
    // Na powiadomienie nie ma odpowiedzi; kolejność odpowiedzi nie jest ustalona, bo most przekazuje równolegle.
    expect(replies).toHaveLength(2);
    expect(replies).toContainEqual(expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: "2025-06-18" }) }));
    const call = replies.find((r) => (r as { id?: number }).id === 2) as { result: { structuredContent: unknown } };
    expect(ListReposResult.parse(call.result.structuredContent).repos.map((r) => r.id)).toEqual(["orders-bff"]);
  });

  test("sondę server/discover odrzuca jak serwer bez tej metody, żeby klient przeszedł na initialize", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-discover-"));
    const discover = {
      jsonrpc: "2.0",
      id: 0,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    };
    const [reply] = await throughBridge(home, [discover]);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 0, error: { code: -32601 } });
  });

  test("bez działającego daemona odpowiada błędem z poleceniem uruchomienia Trackwall", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-nodaemon-"));
    const [reply] = await throughBridge(home, [INITIALIZE]);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32000 } });
    expect(JSON.stringify(reply)).toContain("Uruchom aplikację Trackwall");
  });

  test("z nieaktualnym tokenem w daemon.json zgłasza odrzucenie przez daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-oldtoken-"));
    writeDaemonFile(home, { pid: process.pid, port: api.port, token: "z".repeat(43), startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
    const [reply] = await throughBridge(home, [INITIALIZE]);
    expect(reply).toMatchObject({
      id: 1,
      error: { code: -32000, message: "Trackwall odrzucił żądanie (HTTP 401): missing or invalid token" },
    });
  });

  test("linia, która nie jest JSON-RPC, dostaje błąd parsowania", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-garbage-"));
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
    const done = runStdioBridge({ home, input, output, log: () => {} });
    input.end("to nie json\n");
    await done;
    expect(JSON.parse(lines.join(""))).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "wiadomość nie jest obiektem JSON-RPC" },
    });
  });
});

describe.each(RUNTIMES)("Copilot CLI przez most stdio z komendy daemona pod %s", (_name, runtime) => {
  test("komenda z /api/daemon/info uruchamia most w katalogu agenta i daje listę repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-e2e-"));
    const daemon = Bun.spawn([...runtime, MAIN], { env: { ...process.env, TRACKWALL_HOME: home }, stdout: "ignore", stderr: "pipe" });
    try {
      let file = readDaemonFile(home);
      for (const until = Date.now() + 10_000; !file && Date.now() < until; file = readDaemonFile(home)) await Bun.sleep(50);
      if (!file) throw new Error("daemon nie zapisał daemon.json w 10 s");
      const { port, token } = file;
      const setDir = { method: "POST", token, body: JSON.stringify({ path: projects }), headers: { "content-type": "application/json" } };
      expect((await loopbackRequest(port, workspaceApi.setProjectsDir.path, setDir)).status).toBe(200);
      const info = DaemonInfoResult.parse(JSON.parse((await loopbackRequest(port, "/api/daemon/info", { token })).body));
      if (!info.ok) throw new Error(info.error.message);
      const [command, ...args] = info.data.mcpStdioCommand;
      if (!command) throw new Error("pusta komenda mostu");

      // Agent działa w swoim katalogu (tu: obcym) i z okrojonym środowiskiem SDK, bez TRACKWALL_HOME daemona.
      const agentCwd = mkdtempSync(join(tmpdir(), "trackwall-mcp-agent-"));
      // Jak Copilot CLI: najpierw sonda rewizji 2026-07-28, potem `initialize`.
      const client = new Client({ name: "copilot-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
      await client.connect(new StdioClientTransport({ command, args, cwd: agentCwd, stderr: "ignore" }));
      const result = await client.callTool({ name: "list_repos", arguments: {} });
      expect(ListReposResult.parse(result.structuredContent).repos.map((r) => r.id)).toEqual(["orders-bff"]);
      await client.close();
    } finally {
      daemon.kill();
      await daemon.exited;
    }
  }, 30_000);
});

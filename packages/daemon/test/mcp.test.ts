import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  DaemonInfoResult,
  FindEndpointResult,
  GetRepoResult,
  ListReposResult,
  LogErrors,
  LogTail,
  MCP_INSTRUCTIONS,
  mcpTools,
  RepoCardResult,
  SearchCodeResult,
  Subgraph,
  WhoCallsResult,
  workspaceApi,
} from "@trackwall/protocol";
import { z } from "zod";
import { EventHub } from "../src/api/event-hub.ts";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade, type Facade } from "../src/facade.ts";
import { readDaemonFile, writeDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { createMcpEndpoint, MCP_PATH } from "../src/mcp/endpoint.ts";
import { runStdioBridge } from "../src/mcp/stdio-bridge.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const TOKEN = "m".repeat(43);
const README = "# Zamówienia\n\nBFF sklepu.\n";
const POM =
  "<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId>" +
  "<version>3.3.0</version></parent><groupId>com.example</groupId><artifactId>orders-bff</artifactId></project>\n";
let api: ApiServer;
let home: string;
let facade: Facade;
let projects: string;
let orders: string;
const logs: string[] = [];

beforeAll(async () => {
  projects = mkdtempSync(join(tmpdir(), "trackwall-mcp-projects-"));
  orders = makeRepo({ "README.md": README, "pom.xml": POM, "src/app.ts": "export {};\n" }, "orders-bff", projects);
  gitIn(orders, "remote", "add", "origin", "git@gitlab.example.com:sklep/orders-bff.git");
  home = mkdtempSync(join(tmpdir(), "trackwall-mcp-home-"));
  facade = createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    // Program, którego nie ma w PATH: lista tasków mise jest wtedy stanem `not_installed`, na każdej maszynie tak samo.
    miseCommand: ["trackwall-test-brak-mise"],
    copilotCommand: ["copilot"],
    version: "0.0.0-test",
    hookCommand: () => ({ exec: "true", args: [] }),
    sessionMcpCommand: (tokenFile) => ["trackwall-daemon", "mcp-stdio", "--session-token-file", tokenFile],
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
    mcp: createMcpEndpoint({ facade, version: "9.9.9", log: (msg) => logs.push(msg) }),
    events: new EventHub({ facade, log: () => {} }),
  });
});

afterAll(() => api.close());

describe("serwer MCP przez Streamable HTTP", () => {
  test("announces the repo, card, log, graph, code search, session, mise task and service tools, with the ones that run, stop or call repo code as destructive", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_repos",
      "get_repo",
      "get_repo_card",
      "tail",
      "get_errors",
      "who_calls",
      "subgraph_for",
      "find_endpoint",
      "search_code",
      "list_sessions",
      "get_session",
      "propose_task",
      "report_result",
      "wait_for_session",
      "run_mise_task",
      "stop_mise_task",
      "wait_for_mise_task",
      "list_running_mise_tasks",
      "start_service",
      "stop_service",
      "list_services",
      "call_endpoint",
    ]);
    // Każde narzędzie z kontraktu, który pokazuje UI, jest zarejestrowane w daemonie.
    expect(tools.map((t) => t.name)).toEqual(Object.values(mcpTools).map((t) => t.name));
    const writing = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writing).toEqual([
      "propose_task",
      "report_result",
      "run_mise_task",
      "stop_mise_task",
      "start_service",
      "stop_service",
      "call_endpoint",
    ]);
    // A proposal and a summary only write text for a human; running a mise task executes repo code, and stopping one
    // can kill a process the user started from the UI; so do starting and stopping a service, and a request to a service
    // can change its data.
    expect(tools.filter((t) => t.annotations?.destructiveHint !== false).map((t) => t.name)).toEqual([
      "run_mise_task",
      "stop_mise_task",
      "start_service",
      "stop_service",
      "call_endpoint",
    ]);
    expect(client.getServerVersion()).toMatchObject({ name: "trackwall", version: "9.9.9" });
    await client.close();
  });

  test("the server instruction says when to use every tool, so a new tool cannot be left out of it", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(MCP_INSTRUCTIONS);
    const missing = Object.values(mcpTools).filter((t) => !new RegExp(`\\b${t.name}\\b`).test(instructions));
    expect(missing.map((t) => t.name)).toEqual([]);
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
      tags: ["backend", "bff", "java", "no-mise"],
    });
    // Tekst wyniku to ten sam JSON dla klientów, które nie czytają `structuredContent`.
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(logs.some((l) => l.startsWith("list_repos: ok"))).toBe(true);
    await client.close();
  });

  test("get_repo zwraca README, ostatnie commity i stan tasków mise", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "orders-bff" } });
    const data = GetRepoResult.parse(result.structuredContent);
    expect(data.repo.id).toBe("orders-bff");
    expect(data.readme).toEqual({ path: "README.md", text: README, truncated: false, format: "markdown" });
    expect(data.commits.map((c) => c.subject)).toEqual(["pierwszy commit"]);
    expect(data.miseTasks.kind).toBe("not_installed");
    await client.close();
  });

  test("list_repos z tagami zwraca tylko repo z każdym z nich", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const ids = async (tags: string[]) =>
      ListReposResult.parse((await client.callTool({ name: "list_repos", arguments: { tags } })).structuredContent).repos.map((r) => r.id);
    expect(await ids(["java", "bff"])).toEqual(["orders-bff"]);
    expect(await ids(["java", "frontend"])).toEqual([]);
    await client.close();
  });

  test("get_repo_card zwraca kartę z dowodami i tagi z powodami", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo_card", arguments: { repo: "orders-bff" } });
    const data = RepoCardResult.parse(result.structuredContent);
    expect(data.card?.provides.map((p) => (p.kind === "package" ? p.name : p.kind))).toEqual(["com.example:orders-bff"]);
    expect(data.card?.mechanisms.map((m) => [m.id, m.evidence[0]?.path])).toEqual([["spring-boot", "pom.xml"]]);
    expect(data.tags.find((t) => t.name === "backend")?.reason).toBe("spring-boot in pom.xml:1");
    await client.close();
  });

  test("who_calls i subgraph_for zwracają krawędzie z grafu połączeń, a subgraph_for ma domyślną głębokość 1", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const calls = await client.callTool({ name: "who_calls", arguments: { repo: "orders-bff" } });
    expect(WhoCallsResult.parse(calls.structuredContent)).toEqual({ repo: "orders-bff", edges: [] });
    const sub = Subgraph.parse((await client.callTool({ name: "subgraph_for", arguments: { repo: "orders-bff" } })).structuredContent);
    expect(sub.depth).toBe(1);
    expect(sub.nodes.map((n) => [n.repo, n.remote, n.tags])).toEqual([
      ["orders-bff", "gitlab.example.com/sklep/orders-bff", ["backend", "bff", "java", "no-mise"]],
    ]);
    const unknown = await client.callTool({ name: "who_calls", arguments: { repo: "nie-ma" } });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toEqual([{ type: "text", text: 'not_found: no repo "nie-ma" in the projects folder' }]);
    const tooDeep = await client.callTool({ name: "subgraph_for", arguments: { repo: "orders-bff", depth: 9 } });
    expect(tooDeep.isError).toBe(true);
    await client.close();
  });

  test("find_endpoint zwraca endpointy pasujące do zapytania, a puste zapytanie odrzuca jak każdy zły argument", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const found = await client.callTool({ name: "find_endpoint", arguments: { query: "/api/orders/42", method: "GET" } });
    // Repo z tego testu nie ma kontrolerów; endpointy i ich klientów na kilku repo sprawdza graph-http.test.ts.
    expect(FindEndpointResult.parse(found.structuredContent)).toEqual({ query: "/api/orders/42", endpoints: [], truncated: false });
    const empty = await client.callTool({ name: "find_endpoint", arguments: { query: "" } });
    expect(empty.isError).toBe(true);
    await client.close();
  });

  test("search_code returns matches with context, with tags only from repos with every one of them, and an unknown repo is not_found", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const search = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "search_code", arguments: args })).structuredContent;
    const head = gitIn(orders, "rev-parse", "HEAD").trim();

    // By default a fixed string, case-sensitive, with two context lines.
    expect(SearchCodeResult.parse(await search({ pattern: "BFF" }))).toEqual({
      matches: [
        {
          repo: "orders-bff",
          path: "README.md",
          line: 3,
          column: 1,
          text: "BFF sklepu.",
          before: [
            { line: 1, text: "# Zamówienia" },
            { line: 2, text: "" },
          ],
          after: [],
        },
      ],
      truncated: false,
      searched: [{ repo: "orders-bff", commit: head, truncated: false }],
      failed: [],
      skipped: [],
    });
    const searched = async (tags: string[]) => SearchCodeResult.parse(await search({ pattern: "x", tags })).searched.map((r) => r.repo);
    expect(await searched(["java", "bff"])).toEqual(["orders-bff"]);
    expect(await searched(["frontend"])).toEqual([]);
    const unknown = await client.callTool({ name: "search_code", arguments: { pattern: "x", repos: ["missing"] } });
    expect(unknown.content).toEqual([{ type: "text", text: 'not_found: no repo "missing" in the projects folder' }]);
    // A repo outside the tags does not hide an unknown id, and an empty tag list is no filter.
    const unknownTagged = await client.callTool({ name: "search_code", arguments: { pattern: "x", repos: ["missing"], tags: ["java"] } });
    expect(unknownTagged.isError).toBe(true);
    expect(await searched([])).toEqual(["orders-bff"]);
    // A newline would make git search for every line of the pattern separately.
    const multiline = await client.callTool({ name: "search_code", arguments: { pattern: "BFF\nsklepu" } });
    expect(multiline.isError).toBe(true);
    await client.close();
  });

  test("zły repoTags w workspace.yaml: list_repos bez filtra daje repo bez tagów, z filtrem błąd, a get_repo README bez tagów", async () => {
    const workspaceFile = join(home, "workspace.yaml");
    const valid = readFileSync(workspaceFile, "utf8");
    writeFileSync(workspaceFile, `${valid}repoTags:\n  Zła-Nazwa: ["*"]\n`);
    const client = await connectHttpClient(api.port, TOKEN);
    try {
      const all = ListReposResult.parse((await client.callTool({ name: "list_repos", arguments: {} })).structuredContent);
      expect(all.repos.map((r) => [r.id, r.tags])).toEqual([["orders-bff", []]]);
      const filtered = await client.callTool({ name: "list_repos", arguments: { tags: ["java"] } });
      expect(filtered.isError).toBe(true);
      const repo = GetRepoResult.parse((await client.callTool({ name: "get_repo", arguments: { repo: "orders-bff" } })).structuredContent);
      expect(repo.repo.tags).toEqual([]);
      expect(repo.readme?.text).toBe(README);
    } finally {
      writeFileSync(workspaceFile, valid);
      await client.close();
    }
  });

  test("get_repo z nieznanym repo zwraca błąd narzędzia z kodem, a nie błąd protokołu", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "nie-ma-takiego" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: 'not_found: no repo "nie-ma-takiego" in the projects folder' }]);
    await client.close();
  });

  test("get_repo odrzuca identyfikator spoza schematu RepoId", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const result = await client.callTool({ name: "get_repo", arguments: { repo: "../etc" } });
    expect(result.isError).toBe(true);
    // Odrzuca schemat w SDK, zanim identyfikator dotrze do workspace (tam byłoby `not_found`).
    expect(JSON.stringify(result.content)).toContain("repo id");
    expect(JSON.stringify(result.content)).not.toContain("not_found");
    await client.close();
  });

  test("tail zwraca zamaskowany log taska mise od kursora", async () => {
    const output = facade.logs.open({ kind: "mise-task", repo: "orders-bff", miseTask: "dev" }, "r1", { DB_PASSWORD: "tajne-haslo-123" });
    output.push("stdout", Buffer.from("start\nERROR baza: tajne-haslo-123\n"));
    const client = await connectHttpClient(api.port, TOKEN);

    const first = LogTail.parse(
      (await client.callTool({ name: "tail", arguments: { repo: "orders-bff", miseTask: "dev", limit: 1 } })).structuredContent,
    );
    expect(first.records.map((r) => [r.level, r.msg])).toEqual([["error", "ERROR baza: ***"]]);

    output.push("stdout", Buffer.from("gotowe\n"));
    const next = LogTail.parse(
      (await client.callTool({ name: "tail", arguments: { repo: "orders-bff", miseTask: "dev", sinceSeq: first.nextSeq, limit: 10 } }))
        .structuredContent,
    );
    expect(next.records.map((r) => r.msg)).toEqual(["gotowe"]);
    expect(next.dropped).toBe(false);
    await client.close();
  });

  test("tail z nieznanym repo zwraca not_found, a task bez wyjścia pusty log", async () => {
    const client = await connectHttpClient(api.port, TOKEN);
    const missing = await client.callTool({ name: "tail", arguments: { repo: "nie-ma-takiego", miseTask: "dev", limit: 10 } });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: "text", text: 'not_found: no repo "nie-ma-takiego" in the projects folder' }]);

    const empty = LogTail.parse(
      (await client.callTool({ name: "tail", arguments: { repo: "orders-bff", miseTask: "build", limit: 10 } })).structuredContent,
    );
    expect(empty.records).toEqual([]);
    await client.close();
  });

  test("get_errors returns a masked error with its stack trace after the cursor, and an unknown repo is not_found", async () => {
    const output = facade.logs.open({ kind: "mise-task", repo: "orders-bff", miseTask: "test" }, "r2", { DB_PASSWORD: "tajne-haslo-123" });
    const client = await connectHttpClient(api.port, TOKEN);
    const cursor = LogErrors.parse(
      (await client.callTool({ name: "get_errors", arguments: { repo: "orders-bff" } })).structuredContent,
    ).nextSeq;
    output.push("stderr", Buffer.from("java.sql.SQLException: login failed for tajne-haslo-123\n\tat com.example.Db.connect(Db.java:7)\n"));

    const result = await client.callTool({ name: "get_errors", arguments: { repo: "orders-bff", sinceSeq: cursor } });
    expect(LogErrors.parse(result.structuredContent)).toMatchObject({
      errors: [
        {
          source: { kind: "mise-task", repo: "orders-bff", miseTask: "test" },
          exception: "java.sql.SQLException: login failed for ***",
          lines: ["java.sql.SQLException: login failed for ***", "\tat com.example.Db.connect(Db.java:7)"],
          count: 1,
        },
      ],
      truncated: false,
      dropped: false,
    });

    const missing = await client.callTool({ name: "get_errors", arguments: { repo: "nie-ma-takiego" } });
    expect(missing.content).toEqual([{ type: "text", text: 'not_found: no repo "nie-ma-takiego" in the projects folder' }]);
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

/** Most w tym samym procesie: linie na wejściu (obiekty jako JSON), odpowiedzi jako obiekty z linii wyjścia. */
async function throughBridge(home: string, messages: (object | string)[], sessionTokenFile?: string): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  const done = runStdioBridge({ home, sessionTokenFile, input, output, log: () => {} });
  for (const m of messages) input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  input.end();
  await done;
  return lines.map((l) => JSON.parse(l));
}

/** Odpowiedź z wynikiem wywołania narzędzia o `id` 2, sprawdzona schematem zamiast rzutowania. */
const ToolCallReply = z.object({ id: z.literal(2), result: z.object({ structuredContent: z.unknown() }) });

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
    const call = replies.map((r) => ToolCallReply.safeParse(r)).find((r) => r.success);
    expect(ListReposResult.parse(call?.data?.result.structuredContent).repos.map((r) => r.id)).toEqual(["orders-bff"]);
  });

  test("w sesji Trackwall wysyła token sesji z pliku, a daemon odrzuca token, którego nie zna", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-session-"));
    writeDaemonFile(home, { pid: process.pid, port: api.port, token: TOKEN, startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
    const tokenFile = join(home, "session-token");
    writeFileSync(tokenFile, "token-zamknietej-sesji");

    const [reply] = await throughBridge(home, [INITIALIZE], tokenFile);
    expect(reply).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.stringify(reply)).toContain("unknown session token");
  });

  test("bez pliku tokenu sesji nie wysyła żądania jako agent spoza Trackwall, tylko zgłasza koniec sesji", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-notoken-"));
    writeDaemonFile(home, { pid: process.pid, port: api.port, token: TOKEN, startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });

    const [reply] = await throughBridge(home, [INITIALIZE], join(home, "nie-ma"));
    expect(reply).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.stringify(reply)).toContain("this session has ended");
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
    expect(JSON.stringify(reply)).toContain("Start the Trackwall app");
  });

  test("z nieaktualnym tokenem w daemon.json zgłasza odrzucenie przez daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-oldtoken-"));
    writeDaemonFile(home, { pid: process.pid, port: api.port, token: "z".repeat(43), startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
    const [reply] = await throughBridge(home, [INITIALIZE]);
    expect(reply).toMatchObject({
      id: 1,
      error: { code: -32000, message: "Trackwall rejected the request (HTTP 401): missing or invalid token" },
    });
  });

  test("linia, która nie jest JSON-em, dostaje błąd parsowania, a JSON spoza JSON-RPC błąd żądania", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-garbage-"));
    expect(await throughBridge(home, ["to nie json"])).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the message is not valid JSON" } },
    ]);
    expect(await throughBridge(home, ["42"])).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "the message is not a JSON-RPC object" } },
    ]);
  });

  test("błąd transportu z id null od daemona trafia do klienta pod identyfikatorem żądania", async () => {
    // Tak SDK odrzuca żądanie, którego nie powiąże z identyfikatorem (np. nieobsługiwana wersja w nagłówku).
    const rejecting = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad Request: wersja" } }));
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    try {
      const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-rejecting-"));
      const { port } = rejecting.address() as AddressInfo;
      writeDaemonFile(home, { pid: process.pid, port, token: TOKEN, startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
      expect(await throughBridge(home, [INITIALIZE])).toEqual([
        { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Bad Request: wersja" } },
      ]);
    } finally {
      rejecting.close();
    }
  });

  test("odpowiedź daemona bez wiadomości o tym id kończy żądanie błędem zamiast ciszy", async () => {
    // Daemon, który zrywa strumień SSE bez danych, jak przy wyjściu w trakcie żądania.
    const silent = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const home = mkdtempSync(join(tmpdir(), "trackwall-mcp-silent-"));
      const { port } = silent.address() as AddressInfo;
      writeDaemonFile(home, { pid: process.pid, port, token: TOKEN, startedAt: "2026-10-23T00:00:00Z", version: "9.9.9" });
      expect(await throughBridge(home, [INITIALIZE])).toEqual([
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Trackwall did not answer the request" } },
      ]);
    } finally {
      silent.close();
    }
  });
});

describe.each(RUNTIMES)("klient MCP jak Copilot CLI przez komendę mostu z daemona pod %s", (_name, runtime) => {
  test("komenda z /api/daemon/info uruchamia most w repo agenta, który nie wstrzyknie mu bunfig.toml, i daje listę repo", async () => {
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

      // Agent działa w repo użytkownika i z okrojonym środowiskiem SDK, bez TRACKWALL_HOME daemona. Repo ma
      // `bunfig.toml` z preloadem, który zostawia ślad, gdyby Bun go wczytał (dotyczy uruchomienia ze źródeł).
      const agentCwd = mkdtempSync(join(tmpdir(), "trackwall-mcp-agent-"));
      const marker = join(agentCwd, "preload-z-repo");
      writeFileSync(join(agentCwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      writeFileSync(join(agentCwd, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`);
      // Jak Copilot CLI: najpierw sonda rewizji 2026-07-28, potem `initialize`.
      const client = new Client({ name: "copilot-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
      await client.connect(new StdioClientTransport({ command, args, cwd: agentCwd, stderr: "ignore" }));
      const result = await client.callTool({ name: "list_repos", arguments: {} });
      expect(ListReposResult.parse(result.structuredContent).repos.map((r) => r.id)).toEqual(["orders-bff"]);
      await client.close();
      expect(existsSync(marker)).toBe(false);
    } finally {
      daemon.kill();
      await daemon.exited;
    }
  }, 30_000);
});

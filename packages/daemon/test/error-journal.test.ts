import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { apiResult, ErrorJournal, errorJournalApi, workspaceApi } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import { type ApiServer, startApi } from "../src/api/server.ts";
import { createFacade, type Facade, HOSTING_CLIS } from "../src/facade.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { createMcpEndpoint } from "../src/mcp/endpoint.ts";
import { makeRepo } from "./support/git-repo.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "e".repeat(43);
let api: ApiServer;
let home: string;
let projects: string;
let uiDir: string;
let facade: Facade;
let mcp: Client;

function newFacade(): Facade {
  return createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: (sessionToken) => ({ url: "http://127.0.0.1:9/mcp", headers: { "x-trackwall-session-token": sessionToken } }),
    hostingClis: HOSTING_CLIS,
    userEnv: async () => process.env,
    uiDir,
    log: () => {},
  });
}

beforeAll(async () => {
  projects = mkdtempSync(join(tmpdir(), "trackwall-errors-projects-"));
  makeRepo({ "README.md": "# Orders\n" }, "orders-bff", projects);
  home = mkdtempSync(join(tmpdir(), "trackwall-errors-home-"));
  // A built UI with one chunk and its source map: generated line 1 is line 42 of `src/views/repos/RepoView.tsx`.
  uiDir = mkdtempSync(join(tmpdir(), "trackwall-errors-ui-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html>");
  writeFileSync(
    join(uiDir, "assets", "index-abc.js.map"),
    JSON.stringify({ version: 3, sources: ["../../src/views/repos/RepoView.tsx"], mappings: "AAyCA" }),
  );
  facade = newFacade();
  await facade.workspace.setProjectsDir(projects);
  api = await startApi({
    token: TOKEN,
    version: "0.0.0-test",
    info: () => {
      throw new Error("not used");
    },
    onShutdown: () => {},
    facade,
    mcp: createMcpEndpoint({ facade, version: "test", log: () => {} }),
    events: new EventHub({ facade, log: () => {} }),
  });
  mcp = await connectHttpClient(api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await mcp.close();
  await api.close();
});

async function post(path: string, body: unknown = {}) {
  return loopbackRequest(api.port, path, {
    method: "POST",
    token: TOKEN,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** An empty journal that has read the workspace, as it has long before an error comes in a running daemon. */
async function emptyJournal() {
  await post(errorJournalApi.clear.path);
  expect(await journal()).toEqual([]);
}

async function journal() {
  const res = await post(errorJournalApi.errors.path);
  const parsed = apiResult(ErrorJournal).parse(JSON.parse(res.body));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.data.errors;
}

/** Makes the repo list fail the way a bug would: an exception that is not a `DomainError`, naming the user's folder and repo. */
function breakRepoList(): () => void {
  const list = facade.workspace.list;
  facade.workspace.list = () => {
    throw new TypeError(`cannot read ${join(projects, "orders-bff", "pom.xml")} on ${hostname()}`);
  };
  return () => {
    facade.workspace.list = list;
  };
}

describe("error journal", () => {
  test("an API action that fails unexpectedly is in the journal once, counted, with its area, frames and an anonymized message", async () => {
    await emptyJournal();
    const restore = breakRepoList();
    try {
      expect((await post(workspaceApi.list.path)).status).toBe(500);
      expect((await post(workspaceApi.list.path)).status).toBe(500);
    } finally {
      restore();
    }
    const errors = await journal();
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error).toMatchObject({ source: "daemon", area: "api:/api/workspace/list", kind: "TypeError", count: 2, version: "0.0.0-test" });
    expect(error?.message).toBe("cannot read <repo>/… on <host>");
    expect(error?.frames.length).toBeGreaterThan(0);
    for (const frame of error?.frames ?? []) expect(frame).toMatch(/^packages\/daemon\/src\/.+:\d+$/);
  });

  test("a request whose address the daemon cannot parse is one entry under a fixed area, and the daemon keeps answering", async () => {
    await emptyJournal();
    const res = await loopbackRequest(api.port, "//", { token: TOKEN });
    expect(res.status).toBe(500);
    expect((await journal()).map((e) => [e.source, e.area])).toEqual([["daemon", "api:other"]]);
  });

  test("a request the API refuses is the caller's mistake and stays out of the journal", async () => {
    await emptyJournal();
    expect((await post(workspaceApi.overview.path, { repo: 42 })).status).toBe(400);
    expect((await post(workspaceApi.overview.path, { repo: "no-such-repo" })).status).toBe(404);
    expect(await journal()).toEqual([]);
  });

  test("an MCP tool that fails unexpectedly is in the journal under the tool; arguments the schema refuses are not", async () => {
    await emptyJournal();
    const restore = breakRepoList();
    try {
      const failed = await mcp.callTool({ name: "list_repos", arguments: {} });
      expect(failed.isError).toBe(true);
    } finally {
      restore();
    }
    const refused = await mcp.callTool({ name: "get_repo", arguments: { repo: 42 } });
    expect(refused.isError).toBe(true);
    expect((await journal()).map((e) => [e.source, e.area, e.kind])).toEqual([["daemon", "mcp:list_repos", "TypeError"]]);
  });

  test("an error the UI reports is mapped through the chunk's source map to the UI's sources and its folder", async () => {
    await emptyJournal();
    const res = await post(errorJournalApi.recordUiError.path, {
      page: "window",
      name: "TypeError",
      message: `x is undefined in ${join(projects, "orders-bff")}`,
      stack: "TypeError: x is undefined\n    at Ce (http://127.0.0.1:51234/assets/index-abc.js:1:1)",
    });
    expect(res.status).toBe(200);
    const [error] = await journal();
    expect(error).toMatchObject({
      source: "ui",
      area: "ui:views/repos",
      kind: "TypeError",
      message: "x is undefined in <repo>",
      frames: ["packages/ui/src/views/repos/RepoView.tsx:42"],
    });
  });

  test("a UI report bigger than its limits is refused", async () => {
    const res = await post(errorJournalApi.recordUiError.path, { page: "window", name: "E", message: "x".repeat(5000), stack: "" });
    expect(res.status).toBe(400);
  });

  test("the shell's errors are taken from its file into the journal, once", async () => {
    await emptyJournal();
    const file = join(home, "logs", "shell-errors.jsonl");
    mkdirSync(join(home, "logs"), { recursive: true });
    const line = {
      atMs: Date.parse("2026-10-27T10:00:00Z"),
      area: "badge",
      kind: "error",
      message: `tray icon: ${projects}`,
      location: "src/badge.rs:201",
    };
    writeFileSync(file, `${JSON.stringify(line)}\nnot json\n${JSON.stringify(line)}\n`);
    const errors = await journal();
    expect(errors).toEqual([
      {
        fingerprint: expect.any(String),
        source: "shell",
        area: "shell:badge",
        kind: "error",
        message: "tray icon: <projects>",
        frames: ["apps/desktop/src-tauri/src/badge.rs:201"],
        count: 2,
        firstSeen: "2026-10-27T10:00:00.000Z",
        lastSeen: "2026-10-27T10:00:00.000Z",
        version: "0.0.0-test",
      },
    ]);
    expect(existsSync(file)).toBe(false);
    expect((await journal())[0]?.count).toBe(2);
  });

  test("an error kept from before the workspace was read counts its next occurrence on the same entry", async () => {
    await emptyJournal();
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "logs", "errors.json"),
      JSON.stringify({
        errors: [
          {
            fingerprint: "000000000000",
            source: "daemon",
            area: "startup",
            kind: "Error",
            message: "repo orders-bff: rebase failed",
            frames: [],
            count: 1,
            firstSeen: "2026-10-27T10:00:00.000Z",
            lastSeen: "2026-10-27T10:00:00.000Z",
            version: "0.0.0-test",
          },
        ],
      }),
    );
    const next = newFacade();
    const again = new Error("repo orders-bff: rebase failed");
    again.stack = "Error: repo orders-bff: rebase failed";
    await next.errorJournal.list();
    next.errorJournal.recordDaemonError("startup", again);
    expect((await next.errorJournal.list()).errors.map((e) => [e.message, e.count])).toEqual([["repo <repo>: rebase failed", 2]]);
    await post(errorJournalApi.clear.path);
  });

  test("the journal outlives the daemon, and Clear empties it", async () => {
    await emptyJournal();
    await post(errorJournalApi.recordUiError.path, { page: "tray-panel", name: "Error", message: "boom", stack: "" });
    facade.errorJournal.flush();
    const next = newFacade();
    expect((await next.errorJournal.list()).errors.map((e) => [e.area, e.message])).toEqual([["ui:tray-panel", "boom"]]);
    await post(errorJournalApi.clear.path);
    expect(await journal()).toEqual([]);
    expect((await newFacade().errorJournal.list()).errors).toEqual([]);
  });
});

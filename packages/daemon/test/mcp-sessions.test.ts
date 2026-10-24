import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { GetSessionResult, ListSessionsResult } from "@trackwall/protocol";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "s".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  client = await connectHttpClient(daemon.api.port, TOKEN);
});

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

describe.skipIf(process.versions.bun === undefined)("sesje w narzędziach MCP (prawdziwy PTY i git, atrapa Copilot CLI)", () => {
  test("list_sessions pokazuje sesje i zadania, a get_session zadanie sesji ze zmianami bez diffu", async () => {
    const root = await daemon.facade.agents.start("sklep");
    const task = await daemon.facade.agents.createTask("sklep", "dodaj test logowania");
    writeFileSync(join(task.worktree, "login.test.ts"), "test();\ntest();\n");

    const list = ListSessionsResult.parse((await client.callTool({ name: "list_sessions", arguments: {} })).structuredContent);
    const taskSession = list.sessions.find((s) => s.task === task.id);
    expect(list.sessions.map((s) => s.id)).toContain(root.id);
    expect(taskSession).toMatchObject({ repo: "sklep", run: { kind: "running" } });
    expect(list.tasks).toEqual([task]);
    const other = ListSessionsResult.parse(
      (await client.callTool({ name: "list_sessions", arguments: { repo: "inne" } })).structuredContent,
    );
    expect(other).toEqual({ sessions: [], tasks: [] });

    const detail = await client.callTool({ name: "get_session", arguments: { session: taskSession?.id } });
    const data = GetSessionResult.parse(detail.structuredContent);
    expect(data.task).toEqual(task);
    expect(data.changes).toEqual({
      files: [{ path: "login.test.ts", change: "added", additions: 2, deletions: 0 }],
      commits: 0,
      uncommitted: 1,
    });
    expect(detail.structuredContent).not.toHaveProperty("changes.patch");

    const inRoot = GetSessionResult.parse(
      (await client.callTool({ name: "get_session", arguments: { session: root.id } })).structuredContent,
    );
    expect(inRoot).toMatchObject({ session: { id: root.id, task: null }, task: null, changes: null });
  }, 60_000);

  test("get_session nieznanej sesji to błąd not_found, a nie pusty wynik", async () => {
    const result = await client.callTool({ name: "get_session", arguments: { session: "00000000-0000-4000-8000-000000000000" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "not_found: no session 00000000-0000-4000-8000-000000000000" }]);
  });
});

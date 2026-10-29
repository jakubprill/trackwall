import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { GetSessionResult, ListSessionsResult } from "@trackwall/protocol";
import { removeFolder } from "../src/infra/remove-folder.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "s".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  client = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

describe.skipIf(process.versions.bun === undefined)("sessions in MCP tools (real PTY and git, fake Copilot CLI)", () => {
  test("list_sessions shows sessions and tasks, and get_session the session's task with changes without the diff", async () => {
    const root = await daemon.facade.agents.start("shop");
    const task = await daemon.facade.agents.createTask("shop", "add a login test");
    writeFileSync(join(task.worktree, "login.test.ts"), "test();\ntest();\n");

    const list = ListSessionsResult.parse((await client.callTool({ name: "list_sessions", arguments: {} })).structuredContent);
    const taskSession = list.sessions.find((s) => s.task === task.id);
    expect(list.sessions.map((s) => s.id)).toContain(root.id);
    expect(taskSession).toMatchObject({ repo: "shop", run: { kind: "running" } });
    expect(list.tasks).toEqual([task]);
    const inRepo = ListSessionsResult.parse(
      (await client.callTool({ name: "list_sessions", arguments: { repo: "shop" } })).structuredContent,
    );
    expect(inRepo.sessions.map((s) => s.id)).toEqual(list.sessions.map((s) => s.id));
    expect(inRepo.tasks).toEqual([task]);

    const detail = await client.callTool({ name: "get_session", arguments: { session: taskSession?.id } });
    const data = GetSessionResult.parse(detail.structuredContent);
    expect(data.task).toEqual(task);
    expect(data.changes).toEqual({
      files: [{ path: "login.test.ts", change: "added", additions: 2, deletions: 0 }],
      filesTruncated: false,
      commits: 0,
      uncommitted: 1,
    });
    expect(data.changesError).toBeNull();
    expect(detail.structuredContent).not.toHaveProperty("changes.patch");

    const inRoot = GetSessionResult.parse(
      (await client.callTool({ name: "get_session", arguments: { session: root.id } })).structuredContent,
    );
    expect(inRoot).toMatchObject({ session: { id: root.id, task: null }, task: null, changes: null, changesError: null });
  }, 60_000);

  test("an ended session does not give other agents the last lines of its screen", async () => {
    const session = await daemon.facade.agents.start("shop");
    await daemon.facade.agents.stop(session.id);
    expect(daemon.facade.agents.session(session.id).run).toMatchObject({ kind: "exited", lastLines: expect.any(Array) });

    const result = (await client.callTool({ name: "list_sessions", arguments: {} })).structuredContent;
    const listed = ListSessionsResult.parse(result).sessions.find((s) => s.id === session.id);
    expect(listed?.run.kind).toBe("exited");
    expect(listed?.run).not.toHaveProperty("lastLines");
    // Checked before parsing, which would drop a field the schema does not have (ADR-66).
    expect(JSON.stringify(result)).not.toContain('"dialog"');
  }, 60_000);

  test("get_session of a task whose worktree was deleted by hand returns the session and the task, and a reason instead of changes", async () => {
    const task = await daemon.facade.agents.createTask("shop", "the worktree will disappear");
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    await daemon.facade.agents.stop(session?.id ?? "");
    await removeFolder(task.worktree);

    const data = GetSessionResult.parse(
      (await client.callTool({ name: "get_session", arguments: { session: session?.id } })).structuredContent,
    );
    expect(data.task).toEqual(task);
    expect(data.changes).toBeNull();
    expect(data.changesError).toStartWith("not_found: the worktree of task");
  }, 60_000);

  test("a task's changes for an agent have at most 200 files and say there were more", async () => {
    const task = await daemon.facade.agents.createTask("shop", "build output without gitignore");
    for (let i = 0; i < 201; i++) writeFileSync(join(task.worktree, `file-${i}.txt`), "x\n");
    const summary = await daemon.facade.agents.taskChangesSummary(task.id);
    expect(summary.files).toHaveLength(200);
    expect(summary.filesTruncated).toBe(true);
    expect(summary.uncommitted).toBe(201);
  }, 60_000);

  test("list_sessions with an unknown repo is a not_found error, not an empty list", async () => {
    const result = await client.callTool({ name: "list_sessions", arguments: { repo: "skelp" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('"text":"not_found:');
  });

  test("get_session of an unknown session is a not_found error, not an empty result", async () => {
    const result = await client.callTool({ name: "get_session", arguments: { session: "00000000-0000-4000-8000-000000000000" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "not_found: no session 00000000-0000-4000-8000-000000000000" }]);
  });
});

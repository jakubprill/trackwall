import { describe, expect, test } from "bun:test";
import type { McpCall } from "@trackwall/protocol";
import { callerLabel, filterMcpCalls, mcpCallEntry } from "../src/lib/mcp-calls.ts";

const TASK = "3f2a9c1e-0000-4000-8000-000000000000";
const SESSION = "7c1e2d3a-0000-4000-8000-000000000000";
const NOW = new Date("2026-10-31T08:05:00.000Z");

const READ: McpCall = {
  at: "2026-10-31T08:00:00.000Z",
  tool: "get_repo",
  effect: "read",
  caller: null,
  args: { repo: "shop" },
  outcome: { kind: "ok" },
  durationMs: 12,
};
const RUN: McpCall = {
  ...READ,
  tool: "run_mise_task",
  effect: "destructive",
  caller: { session: SESSION, repo: "shop", task: TASK, supervisor: false },
  args: { repo: "shop", task: TASK, miseTask: "test" },
};
const FAILED: McpCall = { ...READ, outcome: { kind: "error", code: "not_found", message: 'no repo "shpo" in the projects folder' } };

describe("the MCP calls list (ADR-152)", () => {
  test("a run of a mise task by a task's agent shows what it ran, where, and that it runs code", () => {
    expect(mcpCallEntry(RUN, NOW)).toEqual({
      tool: "run_mise_task",
      effect: "runs or stops code",
      caller: "Task in shop",
      args: "repo=shop task=3f2a9c1e miseTask=test",
      failed: false,
      outcome: "ok",
      when: "5 min ago · 12 ms",
    });
  });

  test("a failed read shows the code and text the agent got, and a read has no effect label", () => {
    const entry = mcpCallEntry(FAILED, NOW);
    expect(entry.effect).toBeNull();
    expect(entry.failed).toBe(true);
    expect(entry.outcome).toBe('not_found: no repo "shpo" in the projects folder');
  });

  test("a call without kept arguments shows none, a list of repos is joined", () => {
    expect(mcpCallEntry({ ...READ, tool: "list_services", args: {} }, NOW).args).toBeNull();
    expect(mcpCallEntry({ ...READ, args: null }, NOW).args).toBeNull();
    expect(mcpCallEntry({ ...READ, tool: "search_code", args: { repos: ["shop", "orders"] } }, NOW).args).toBe("repos=shop,orders");
  });

  test("the caller is named by where it worked: outside Trackwall, the supervisor, a free session, a session or a task in a repo", () => {
    expect(
      [
        null,
        { session: SESSION, repo: null, task: null, supervisor: true },
        { session: SESSION, repo: null, task: null, supervisor: false },
        { session: SESSION, repo: "shop", task: null, supervisor: false },
        { session: SESSION, repo: "shop", task: TASK, supervisor: false },
      ].map(callerLabel),
    ).toEqual(["Agent outside Trackwall", "Supervisor", "Free session", "Session in shop", "Task in shop"]);
  });

  test("Changes leaves out reads, Errors leaves out calls that ended well", () => {
    const calls = [READ, RUN, FAILED];
    expect(filterMcpCalls(calls, "all")).toEqual(calls);
    expect(filterMcpCalls(calls, "changes")).toEqual([RUN]);
    expect(filterMcpCalls(calls, "errors")).toEqual([FAILED]);
  });
});

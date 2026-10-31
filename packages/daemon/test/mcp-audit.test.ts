import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_AUDIT_MAX_CALLS, type McpCall } from "@trackwall/protocol";
import { McpAudit } from "../src/modules/mcp-audit/mcp-audit.ts";

const TASK = "3f2a9c1e-0000-4000-8000-000000000000";
const SESSION = "7c1e2d3a-0000-4000-8000-000000000000";

function call(tool: string, over: Partial<McpCall> = {}): McpCall {
  return {
    at: "2026-10-31T08:00:00.000Z",
    tool,
    effect: "read",
    caller: null,
    args: { repo: "shop" },
    outcome: { kind: "ok" },
    durationMs: 3,
    ...over,
  };
}

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "trackwall-mcp-audit-"));
}

describe("the MCP audit (ADR-152)", () => {
  test("lists calls newest first, and with a task only the calls of that task's sessions", () => {
    const audit = new McpAudit({ dir: newDir(), log: () => {} });
    audit.record(call("list_repos"));
    audit.record(call("get_repo", { caller: { session: SESSION, repo: "shop", task: TASK, supervisor: false } }));
    audit.record(call("get_repo_card"));

    expect(audit.list().calls.map((c) => c.tool)).toEqual(["get_repo_card", "get_repo", "list_repos"]);
    expect(audit.list(TASK).calls.map((c) => c.tool)).toEqual(["get_repo"]);
    expect(audit.revision()).toBe(3);
  });

  test("the calls of the previous daemon are there after a restart", () => {
    const dir = newDir();
    new McpAudit({ dir, log: () => {} }).record(call("run_mise_task", { effect: "destructive", args: { repo: "shop", miseTask: "test" } }));

    const restarted = new McpAudit({ dir, log: () => {} });
    expect(restarted.list().calls).toEqual([call("run_mise_task", { effect: "destructive", args: { repo: "shop", miseTask: "test" } })]);
  });

  test("an argument value longer than 200 characters and an error text longer than 300 are cut", () => {
    const audit = new McpAudit({ dir: newDir(), log: () => {} });
    audit.record(
      call("search_code", {
        args: { repos: Array.from({ length: 40 }, (_, i) => `repo-number-${i}`) },
        outcome: { kind: "error", code: "bad_request", message: "x".repeat(1000) },
      }),
    );
    const [kept] = audit.list().calls;
    expect(String(kept?.args?.repos)).toHaveLength(200);
    expect(String(kept?.args?.repos)).toStartWith('["repo-number-0","repo-number-1"');
    expect(kept?.outcome).toEqual({ kind: "error", code: "bad_request", message: `${"x".repeat(299)}…` });
  });

  test("a line that is not a call is skipped at the start, the calls around it stay", () => {
    const dir = newDir();
    const file = join(dir, "mcp-calls.jsonl");
    writeFileSync(file, `${JSON.stringify(call("list_repos"))}\n{"tool": "cut by a cra`);
    appendFileSync(file, `\nnot json\n${JSON.stringify(call("get_repo"))}\n`);

    expect(new McpAudit({ dir, log: () => {} }).list().calls.map((c) => c.tool)).toEqual(["get_repo", "list_repos"]);
  });

  test("the file starts again at 1 MB, and the calls kept in memory survive a restart across both files", () => {
    const dir = newDir();
    const audit = new McpAudit({ dir, log: () => {} });
    const previous = join(dir, "mcp-calls.1.jsonl");
    let recorded = 0;
    while (!existsSync(previous)) audit.record(call("get_repo", { args: { repo: `repo-${recorded++}` } }));
    // A few calls into the new file: the newest ones are in it, the rest of the kept ones in the previous file.
    for (let i = 0; i < 10; i++) audit.record(call("get_repo", { args: { repo: `repo-${recorded++}` } }));

    expect(statSync(join(dir, "mcp-calls.jsonl")).size).toBeLessThan(10_000);
    expect(statSync(previous).size).toBeLessThanOrEqual(1024 * 1024);
    const restarted = new McpAudit({ dir, log: () => {} }).list().calls;
    expect(restarted).toHaveLength(MCP_AUDIT_MAX_CALLS);
    expect(restarted[0]?.args).toEqual({ repo: `repo-${recorded - 1}` });
    expect(restarted.at(-1)?.args).toEqual({ repo: `repo-${recorded - MCP_AUDIT_MAX_CALLS}` });
  });

  test("a rotation that fails is reported once, and the calls keep going into the growing file", () => {
    const dir = newDir();
    // A folder with a file where the rotated file goes: renaming onto it fails, as a file held open on Windows does.
    mkdirSync(join(dir, "mcp-calls.1.jsonl", "taken"), { recursive: true });
    const logs: string[] = [];
    const audit = new McpAudit({ dir, log: (msg) => logs.push(msg) });
    let recorded = 0;
    while (statSync(join(dir, "mcp-calls.jsonl"), { throwIfNoEntry: false }) === undefined || recorded < 8000)
      audit.record(call("get_repo", { args: { repo: `repo-${recorded++}` } }));

    expect(statSync(join(dir, "mcp-calls.jsonl")).size).toBeGreaterThan(1024 * 1024);
    expect(logs.filter((l) => l.startsWith("failed to rotate the MCP audit"))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("failed to write"))).toEqual([]);
    expect(readFileSync(join(dir, "mcp-calls.jsonl"), "utf8")).toEndWith(
      `"repo":"repo-${recorded - 1}"},"outcome":{"kind":"ok"},"durationMs":3}\n`,
    );
  });

  test("a call that cannot be written stays in the list and goes to the log, without an error for the agent", () => {
    const dir = newDir();
    // A file where the audit's folder should be: every write fails.
    const notADir = join(dir, "logs");
    writeFileSync(notADir, "");
    const logs: string[] = [];
    const audit = new McpAudit({ dir: notADir, log: (msg) => logs.push(msg) });

    expect(() => audit.record(call("list_repos"))).not.toThrow();
    expect(audit.list().calls.map((c) => c.tool)).toEqual(["list_repos"]);
    expect(logs.filter((l) => l.startsWith("failed to write the MCP audit:"))).toHaveLength(1);
    expect(readFileSync(notADir, "utf8")).toBe("");
  });
});

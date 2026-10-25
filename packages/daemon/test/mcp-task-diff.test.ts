import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { TaskDiff } from "@trackwall/protocol";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "d".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { sklep: { "README.md": "# sklep\n", "src/cart.ts": "export const cart = [];\n" } },
    miseCommand: ["mise"],
  });
  client = await connectHttpClient(daemon.api.port, TOKEN);
});

afterAll(async () => {
  await client.close();
  await daemon.stop();
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: dir });
}

describe.skipIf(process.versions.bun === undefined)("get_task_diff (real git, fake Copilot CLI)", () => {
  test("gives the committed and uncommitted changes of a task's worktree, narrowed by paths", async () => {
    const task = await daemon.facade.agents.createTask("sklep", "add a discount");
    writeFileSync(join(task.worktree, "src", "cart.ts"), "export const cart = [];\nexport const discount = 0.1;\n");
    git(task.worktree, "commit", "-am", "Add a discount");
    mkdirSync(join(task.worktree, "docs"));
    writeFileSync(join(task.worktree, "docs", "discount.md"), "# Discount\n");

    const all = TaskDiff.parse((await client.callTool({ name: "get_task_diff", arguments: { task: task.id } })).structuredContent);
    expect(all.files).toEqual([
      { path: "docs/discount.md", change: "added", additions: 1, deletions: 0 },
      { path: "src/cart.ts", change: "modified", additions: 1, deletions: 0 },
    ]);
    expect(all).toMatchObject({ filesTruncated: false, commits: 1, uncommitted: 1, patchTruncated: false });
    expect(all.patch).toContain("+export const discount = 0.1;\n");
    expect(all.patch).toContain("+# Discount\n");

    const src = TaskDiff.parse(
      (await client.callTool({ name: "get_task_diff", arguments: { task: task.id, paths: ["src/"] } })).structuredContent,
    );
    expect(src.files.map((f) => f.path)).toEqual(["src/cart.ts"]);
    expect(src.patch).not.toContain("Discount");
    expect(src).toMatchObject({ commits: 1, uncommitted: 1 });
  }, 60_000);

  test("cuts a long diff at the last whole line within maxBytes and says so", async () => {
    const task = await daemon.facade.agents.createTask("sklep", "add many lines");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} żółć\n`).join("");
    writeFileSync(join(task.worktree, "long.txt"), lines);

    const diff = TaskDiff.parse(
      (await client.callTool({ name: "get_task_diff", arguments: { task: task.id, maxBytes: 1000 } })).structuredContent,
    );
    expect(diff.patchTruncated).toBe(true);
    expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(1000);
    expect(diff.patch).toEndWith("żółć\n");
    expect(diff.files).toEqual([{ path: "long.txt", change: "added", additions: 200, deletions: 0 }]);
  }, 60_000);

  test("an unknown task is not_found, not an empty diff", async () => {
    const result = await client.callTool({ name: "get_task_diff", arguments: { task: "00000000-0000-4000-8000-000000000000" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('"text":"not_found:');
  });
});

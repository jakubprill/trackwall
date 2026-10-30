import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskFile } from "../src/modules/agents/task-file.ts";

const stored = {
  id: "3f2a9c1e-0000-4000-8000-000000000000",
  repo: "shop",
  repoDir: join(tmpdir(), "shop"),
  worktreesDir: join(tmpdir(), ".trackwall", "worktrees"),
  prompt: "fix",
  branch: "trackwall/fix-3f2a9c",
  baseBranch: "main",
  base: "a".repeat(40),
  createdAt: "2026-10-23T22:00:00.000Z",
  title: "Fix the login",
  proposedBy: { session: "9b1e7d2a-0000-4000-8000-000000000000", supervisor: false },
  model: "claude-opus-5.5",
  approvals: "ask" as const,
  javaNavigation: true,
  item: "7c4d1e2f-0000-4000-8000-000000000000",
  view: "conversation" as const,
  conversation: "c0ffee-1",
  summary: { text: "Fixed, test added.", reportedAt: "2026-10-24T10:00:00.000Z" },
  trustedMiseConfig: { "mise.toml": "b".repeat(64) },
  port: 41003,
  included: { files: [".env", "config/application-local.yml"], problems: ["data.db is not a regular file (a link or a special file)"] },
};

describe("tasks.json", () => {
  test("saved tasks come back after reading, and a missing file means no tasks", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const file = new TaskFile(join(home, "tasks.json"), () => {});
    expect(file.read()).toEqual([]);
    file.write([stored]);
    expect(file.read()).toEqual([stored]);
    // The supervisor's mark survives the file, so its work stays under it after a restart (ADR-58).
    const supervised = { ...stored, proposedBy: { ...stored.proposedBy, supervisor: true } };
    file.write([supervised]);
    expect(file.read()).toEqual([supervised]);
  });

  test("a task saved before task proposals comes back without a title, origin and summary", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const {
      title: _,
      proposedBy: __,
      model: _model,
      approvals: _approvals,
      javaNavigation: _javaNavigation,
      item: _item,
      view: _view,
      conversation: _conversation,
      summary: ___,
      trustedMiseConfig: ____,
      port: _____,
      included: ______,
      ...old
    } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([
      {
        ...old,
        title: null,
        proposedBy: null,
        model: null,
        approvals: "ask",
        javaNavigation: false,
        item: null,
        view: "terminal",
        conversation: null,
        summary: null,
        trustedMiseConfig: null,
        port: null,
        included: { files: [], problems: [] },
      },
    ]);
  });

  test("a task saved before trusted mise configs comes back without one, so its config needs the user's trust once", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { trustedMiseConfig: _, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, trustedMiseConfig: null }]);
  });

  test("a task saved before task ports comes back without a port and without included files", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { port: _, included: __, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([
      { ...old, port: null, included: { files: [], problems: [] } },
    ]);
  });

  test("a task saved before task models comes back without one, so its sessions run on Copilot CLI's default", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { model: _, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, model: null, approvals: "ask" }]);
  });

  test("a task saved before the approvals mode comes back asking, so a resume never drops approvals on its own", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { approvals: _, ...old } = { ...stored, approvals: "auto" };
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, approvals: "ask" }]);
  });

  test("a task saved before Java navigation comes back without it, so its sessions start without a language server", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { javaNavigation: _, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, javaNavigation: false }]);
  });

  test("a task saved before board items comes back working on no item", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { item: _, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, item: null }]);
  });

  test("a task saved before the conversation view comes back in a terminal, whose conversation is under the task's id", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { view: _, conversation: __, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, view: "terminal", conversation: null }]);
  });

  test("a task saved without approvals comes back without them", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const file = new TaskFile(join(home, "tasks.json"), () => {});
    const auto = { ...stored, approvals: "auto" as const };
    file.write([auto]);

    expect(file.read()).toEqual([auto]);
  });

  test("a task saved before the task worktrees folder comes back without one, so its worktree stays in the state directory", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const { worktreesDir: _, ...old } = stored;
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([{ ...old, worktreesDir: null }]);
  });

  test("a task proposed before the supervisor comes back as not the supervisor's", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const old = { ...stored, proposedBy: { session: stored.proposedBy.session } };
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [old] }));

    expect(new TaskFile(join(home, "tasks.json"), () => {}).read()).toEqual([stored]);
  });

  test.each([
    ["a branch outside trackwall/, because ending deletes it with branch -D", { branch: "main" }],
    ["a branch with a path separator, because the worktree directory is made from it", { branch: "trackwall/../../documents" }],
    ["a base commit that is not a full hash, because it goes to git diff", { base: "--output=file" }],
    ["a relative repo root", { repoDir: "shop" }],
    ["a relative task worktrees folder, because the worktree is deleted from it", { worktreesDir: "worktrees" }],
    ["a trusted mise config hash that is not SHA-256", { trustedMiseConfig: { "mise.toml": "not-a-hash" } }],
  ])("a task with %s moves the file aside and does not come back", (_, change) => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const logged: string[] = [];
    const file = new TaskFile(join(home, "tasks.json"), (msg) => logged.push(msg));
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [{ ...stored, ...change }] }));

    expect(file.read()).toEqual([]);
    expect(existsSync(join(home, "tasks.json"))).toBe(false);
    expect(readdirSync(home).filter((name) => name.startsWith("tasks.json.broken-"))).toHaveLength(1);
    expect(logged[0]).toContain("file moved");
  });
});

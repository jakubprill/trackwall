import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskFile } from "../src/modules/agents/task-file.ts";

function stored(worktree: string) {
  return {
    id: "3f2a9c1e-0000-4000-8000-000000000000",
    repo: "sklep",
    repoDir: join(tmpdir(), "sklep"),
    prompt: "napraw",
    branch: "trackwall/napraw-3f2a9c",
    baseBranch: "main",
    base: "a".repeat(40),
    worktree,
    createdAt: "2026-10-23T22:00:00.000Z",
  };
}

describe("tasks.json", () => {
  test("zapisane zadania wracają po odczycie, a brak pliku to brak zadań", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const file = new TaskFile(join(home, "tasks.json"), join(home, "worktrees"), () => {});
    expect(file.read()).toEqual([]);
    const task = stored(join(home, "worktrees", "sklep", "napraw-3f2a9c"));
    file.write([task]);
    expect(file.read()).toEqual([task]);
  });

  test("zadanie z worktree spoza katalogu worktree daemona odkłada plik na bok, bo usunięcie skasowałoby obcy katalog", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const logged: string[] = [];
    const file = new TaskFile(join(home, "tasks.json"), join(home, "worktrees"), (msg) => logged.push(msg));
    writeFileSync(join(home, "tasks.json"), JSON.stringify({ tasks: [stored(join(home, "worktrees", "..", "dokumenty"))] }));

    expect(file.read()).toEqual([]);
    expect(existsSync(join(home, "tasks.json"))).toBe(false);
    expect(readdirSync(home).filter((name) => name.startsWith("tasks.json.broken-"))).toHaveLength(1);
    expect(logged[0]).toContain("leży poza");
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskFile } from "../src/modules/agents/task-file.ts";

const stored = {
  id: "3f2a9c1e-0000-4000-8000-000000000000",
  repo: "sklep",
  repoDir: join(tmpdir(), "sklep"),
  prompt: "napraw",
  branch: "trackwall/napraw-3f2a9c",
  baseBranch: "main",
  base: "a".repeat(40),
  createdAt: "2026-10-23T22:00:00.000Z",
};

describe("tasks.json", () => {
  test("zapisane zadania wracają po odczycie, a brak pliku to brak zadań", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-tasks-"));
    const file = new TaskFile(join(home, "tasks.json"), () => {});
    expect(file.read()).toEqual([]);
    file.write([stored]);
    expect(file.read()).toEqual([stored]);
  });

  test.each([
    ["gałąź spoza trackwall/, bo zakończenie usuwa ją z branch -D", { branch: "main" }],
    ["gałąź z separatorem ścieżki, bo z niej powstaje katalog worktree", { branch: "trackwall/../../dokumenty" }],
    ["commit bazowy, który nie jest pełnym hashem, bo trafia do git diff", { base: "--output=plik" }],
    ["względny korzeń repo", { repoDir: "sklep" }],
  ])("zadanie z %s odkłada plik na bok i nie wraca", (_, change) => {
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

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { REPO } from "../scripts/lib.ts";

// Guards the directory layout from docs/development.md ("Repo layout").
// Sprawdza pliki całego repo, nie paczki desktop; leży tu, bo root nie ma własnych testów.

/** Pierwsze człony ścieżek plików śledzonych przez gita w katalogu: nieśledzone `.DS_Store` czy pliki edytora się nie liczą. */
function trackedRootEntries(dir: string): string[] {
  const files = execFileSync("git", ["ls-files", "--", dir], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  return [
    ...new Set(
      files.map((f) =>
        f
          .slice(dir.length + 1)
          .split("/", 1)
          .join(""),
      ),
    ),
  ].sort();
}

test("w korzeniu src/ daemona leżą tylko punkty wejścia i katalogi z docs/development.md", () => {
  expect(trackedRootEntries("packages/daemon/src")).toEqual(["api", "facade.ts", "infra", "main.ts", "mcp", "modules", "platform"]);
});

test("w korzeniu src/ UI leżą tylko punkty wejścia, a widoki mają foldery nazwane identyfikatorem widoku", () => {
  expect(trackedRootEntries("packages/ui/src")).toEqual(["App.tsx", "components", "index.css", "lib", "main.tsx", "views"]);
  expect(trackedRootEntries("packages/ui/src/views")).toEqual(["daemon", "graph", "home", "repos", "sessions", "settings"]);
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { REPO } from "../scripts/lib.ts";

// Guards the directory layout from docs/development.md ("Repo layout").
// Checks files of the whole repo, not of the desktop package; it lives here because the root has no tests of its own.

/** The first segments of paths of files git tracks in a directory: untracked `.DS_Store` or editor files do not count. */
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

test("the root of the daemon's src/ holds only the entry points and directories from docs/development.md", () => {
  expect(trackedRootEntries("packages/daemon/src")).toEqual(["api", "facade.ts", "infra", "main.ts", "mcp", "modules", "platform"]);
});

test("the root of the UI's src/ holds only entry points, and views have folders named after the view identifier", () => {
  expect(trackedRootEntries("packages/ui/src")).toEqual(["App.tsx", "components", "index.css", "lib", "main.tsx", "views"]);
  expect(trackedRootEntries("packages/ui/src/views")).toEqual(["graph", "home", "repos", "sessions", "settings", "tray-panel"]);
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGrep } from "../src/modules/vcs/grep.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import type { CodeSearchQuery } from "../src/modules/workspace/code-search.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** A workspace whose projects folder holds the repos `orders` and `web` and a repo `empty` without commits. */
async function workspaceWithRepos() {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-search-"));
  const orders = makeRepo(
    {
      "src/main/java/Orders.java": "class Orders {\n  // TODO: validation\n  void place() {}\n  void cancel() {}\n}\n",
      "src/test/java/OrdersTest.java": "class OrdersTest {\n  // TODO: more tests\n}\n",
      "windows.txt": "first\r\nTODO in CRLF\r\nlast\r\n",
    },
    "orders",
    projects,
  );
  makeRepo({ "src/app.ts": "// todo: lower case\nexport const api = '/api/orders';\n" }, "web", projects);
  mkdirSync(join(projects, "empty"));
  gitIn(join(projects, "empty"), "init", "-q");
  const workspace = new Workspace({
    file: new WorkspaceFile(join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml")),
    vcs: new Vcs(),
    hosting: fakeHosting().hosting,
    openEditor: () => {},
  });
  await workspace.setProjectsDir(projects);
  return { workspace, orders };
}

const QUERY: Omit<CodeSearchQuery, "pattern"> = { regex: false, ignoreCase: false, paths: [], context: 0, limit: 100 };

describe("code search", () => {
  test("a fixed string finds matches in every repo with a commit, in list order, with the column and without the \\r of CRLF", async () => {
    const { workspace, orders } = await workspaceWithRepos();
    const head = gitIn(orders, "rev-parse", "HEAD").trim();

    const result = await workspace.searchCode({ ...QUERY, pattern: "TODO" }, {});

    expect(result.matches.map((m) => [m.repo, m.path, m.line, m.column, m.text])).toEqual([
      ["orders", "src/main/java/Orders.java", 2, 6, "  // TODO: validation"],
      ["orders", "src/test/java/OrdersTest.java", 2, 6, "  // TODO: more tests"],
      ["orders", "windows.txt", 2, 1, "TODO in CRLF"],
    ]);
    // A repo without commits has nothing to search, so it is neither searched nor failed.
    expect(result.searched).toEqual([
      { repo: "orders", commit: head },
      { repo: "web", commit: gitIn(join(orders, "..", "web"), "rev-parse", "HEAD").trim() },
    ]);
    expect(result).toMatchObject({ truncated: false, failed: [] });
  });

  test("ignoreCase, a regular expression and a pathspec with an exclusion narrow the matches", async () => {
    const { workspace } = await workspaceWithRepos();
    const found = async (query: Partial<typeof QUERY> & { pattern: string }) =>
      (await workspace.searchCode({ ...QUERY, ...query }, {})).matches.map((m) => `${m.repo}:${m.path}:${m.line}`);

    expect(await found({ pattern: "todo", ignoreCase: true, paths: ["*.ts"] })).toEqual(["web:src/app.ts:1"]);
    expect(await found({ pattern: "void (place|cancel)\\(", regex: true })).toEqual([
      "orders:src/main/java/Orders.java:3",
      "orders:src/main/java/Orders.java:4",
    ]);
    expect(await found({ pattern: "TODO", paths: ["*.java", ":!src/test/"] })).toEqual(["orders:src/main/java/Orders.java:2"]);
    // Without `regex` a parenthesis is an ordinary character.
    expect(await found({ pattern: "place()" })).toEqual(["orders:src/main/java/Orders.java:3"]);
  });

  test("context is the lines before and after a match, and a neighbouring match is context of the other", async () => {
    const { workspace } = await workspaceWithRepos();

    const { matches } = await workspace.searchCode({ ...QUERY, pattern: "void", context: 1 }, { repos: ["orders"] });

    expect(matches).toEqual([
      {
        repo: "orders",
        path: "src/main/java/Orders.java",
        line: 3,
        column: 3,
        text: "  void place() {}",
        before: [{ line: 2, text: "  // TODO: validation" }],
        after: [{ line: 4, text: "  void cancel() {}" }],
      },
      {
        repo: "orders",
        path: "src/main/java/Orders.java",
        line: 4,
        column: 3,
        text: "  void cancel() {}",
        before: [{ line: 3, text: "  void place() {}" }],
        after: [{ line: 5, text: "}" }],
      },
    ]);
  });

  test("searches the HEAD commit, not uncommitted changes in the working tree", async () => {
    const { workspace, orders } = await workspaceWithRepos();
    commitFiles(orders, { "committed.txt": "TODO in a commit\n" }, "second commit");
    writeFileSync(join(orders, "new.txt"), "TODO uncommitted\n");
    writeFileSync(join(orders, "windows.txt"), "changed without a commit\n");

    const { matches } = await workspace.searchCode({ ...QUERY, pattern: "TODO" }, { repos: ["orders"] });

    expect(matches.map((m) => m.path)).toEqual([
      "committed.txt",
      "src/main/java/Orders.java",
      "src/test/java/OrdersTest.java",
      "windows.txt",
    ]);
  });

  test("limit cuts the matches and sets truncated, and a long line is cut to 500 characters", async () => {
    const { workspace, orders } = await workspaceWithRepos();
    commitFiles(orders, { "long.txt": `TODO ${"x".repeat(2000)}\n` }, "long line");

    const limited = await workspace.searchCode({ ...QUERY, pattern: "TODO", limit: 2 }, {});
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const long = await workspace.searchCode({ ...QUERY, pattern: "TODO", paths: ["long.txt"] }, {});
    expect(long.matches[0]?.text).toHaveLength(500);
  });

  test("repos and among narrow the choice: an unknown repo in repos is not_found, one outside among simply drops out", async () => {
    const { workspace } = await workspaceWithRepos();

    const among = await workspace.searchCode({ ...QUERY, pattern: "TODO", ignoreCase: true }, { among: ["web", "missing"] });
    expect(among.searched.map((r) => r.repo)).toEqual(["web"]);
    const both = await workspace.searchCode({ ...QUERY, pattern: "TODO" }, { repos: ["orders"], among: ["web"] });
    expect(both.searched).toEqual([]);

    await expect(workspace.searchCode({ ...QUERY, pattern: "TODO" }, { repos: ["missing"] })).rejects.toMatchObject({
      code: "not_found",
      message: 'no repo "missing" in the projects folder',
    });
  });

  test("an invalid regex puts each repo in failed with git's message instead of failing the whole search", async () => {
    const { workspace } = await workspaceWithRepos();

    const result = await workspace.searchCode({ ...QUERY, pattern: "(", regex: true }, {});

    expect(result.matches).toEqual([]);
    expect(result.searched).toEqual([]);
    expect(result.failed.map((f) => f.repo)).toEqual(["orders", "web"]);
    expect(result.failed[0]?.message).toContain("(");
  });
});

describe("parseGrep", () => {
  test("tells a match from context by the number of fields and skips group separators and lines of another shape", () => {
    const commit = "a".repeat(40);
    const out = [
      `${commit}:src/a.ts\x001\x003\x00a foo`,
      `${commit}:src/a.ts\x002\x00b 12`,
      "--",
      `${commit}:src/a.ts\x009\x001\x00foo`,
      // A path with a newline splits into two output lines; neither is a match.
      `${commit}:wei`,
      `rd.txt\x001\x001\x00foo`,
      "",
    ].join("\n");

    expect(parseGrep(out, commit)).toEqual([
      { path: "src/a.ts", line: 1, column: 3, text: "a foo" },
      { path: "src/a.ts", line: 2, column: null, text: "b 12" },
      { path: "src/a.ts", line: 9, column: 1, text: "foo" },
    ]);
  });
});

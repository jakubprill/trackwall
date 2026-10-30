import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseLogSearch } from "../src/modules/vcs/log-search.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { type CommitSearchQuery, searchCommits } from "../src/modules/workspace/commit-search.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { gitIn } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** Commits `files` in `dir` as `author` at `date` (author and committer time), so the order of the result is fixed. */
function commitAt(dir: string, date: string, author: string, message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const identity = ["-c", `user.name=${author}`, "-c", `user.email=${author.toLowerCase()}@example.com`, "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, "add", "-A"], { cwd: dir, env });
  execFileSync("git", [...identity, "commit", "-q", "-m", message], { cwd: dir, env });
}

function newRepo(projects: string, name: string): string {
  const dir = join(projects, name);
  mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  return dir;
}

/**
 * The projects folder of a field rename across two repos: `orders` adds `price` and later renames it to `amount`,
 * `web` reads `price` and follows the rename; `empty` has no commits.
 */
async function workspaceWithHistory() {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-commits-"));
  const orders = newRepo(projects, "orders");
  const web = newRepo(projects, "web");
  commitAt(orders, "2026-10-01T10:00:00+02:00", "Ann", "Add the order DTO", { "src/OrderDto.java": "class OrderDto { int price; }\n" });
  commitAt(web, "2026-10-02T09:00:00Z", "Bob", "SHOP-12 Show the price", { "src/order.ts": "export const label = (o) => o.price;\n" });
  commitAt(orders, "2026-10-20T08:00:00Z", "Ann", "SHOP-34 Rename price to amount", {
    "src/OrderDto.java": "class OrderDto { int amount; }\n",
    "README.md": "Orders\n",
  });
  commitAt(web, "2026-10-21T12:00:00+02:00", "Bob", "SHOP-34 Follow the rename", {
    "src/order.ts": "export const label = (o) => o.amount;\n",
  });
  mkdirSync(join(projects, "empty"));
  gitIn(join(projects, "empty"), "init", "-q");
  const workspace = new Workspace({
    file: new WorkspaceFile(join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml")),
    vcs: new Vcs(systemTempFolder),
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
    afterClone: async () => {},
  });
  await workspace.setProjectsDir(projects);
  return { workspace, orders, web };
}

/** Each test first creates repos and commits with git, which on a slow Windows runner takes longer than bun's default 5 s. */
const REPOS_SETUP_MS = 20_000;

const QUERY: CommitSearchQuery = { regex: false, ignoreCase: false, paths: [], limit: 50 };

const subjects = (result: { commits: { repo: string; subject: string }[] }) => result.commits.map((c) => `${c.repo}: ${c.subject}`);

describe("commit search", () => {
  test(
    "text finds the commits that add or remove it in every repo, newest first, with only the files where it changed",
    async () => {
      const { workspace, orders, web } = await workspaceWithHistory();

      const result = await workspace.searchCommits({ ...QUERY, text: "price" });

      expect(result.commits).toEqual([
        {
          repo: "web",
          hash: gitIn(web, "rev-parse", "HEAD").trim(),
          author: "Bob",
          date: "2026-10-21T12:00:00+02:00",
          subject: "SHOP-34 Follow the rename",
          files: ["src/order.ts"],
          filesTruncated: false,
        },
        {
          repo: "orders",
          hash: gitIn(orders, "rev-parse", "HEAD").trim(),
          author: "Ann",
          date: "2026-10-20T08:00:00Z".replace("Z", "+00:00"),
          subject: "SHOP-34 Rename price to amount",
          // The README of the same commit does not contain the text.
          files: ["src/OrderDto.java"],
          filesTruncated: false,
        },
        expect.objectContaining({ repo: "web", subject: "SHOP-12 Show the price" }),
        expect.objectContaining({ repo: "orders", subject: "Add the order DTO" }),
      ]);
      // A repo without commits has no history, so it is neither searched nor failed.
      expect(result.searched.map((r) => [r.repo, r.truncated])).toEqual([
        ["orders", false],
        ["web", false],
      ]);
      expect(result).toMatchObject({ truncated: false, failed: [], skipped: [] });
    },
    REPOS_SETUP_MS,
  );

  test(
    "message, author, paths, since and ignoreCase narrow the commits",
    async () => {
      const { workspace } = await workspaceWithHistory();
      const found = async (query: Partial<CommitSearchQuery>) => subjects(await workspace.searchCommits({ ...QUERY, ...query }));

      expect(await found({ message: "SHOP-34" })).toEqual(["web: SHOP-34 Follow the rename", "orders: SHOP-34 Rename price to amount"]);
      expect(await found({ author: "ann@example" })).toEqual(["orders: SHOP-34 Rename price to amount", "orders: Add the order DTO"]);
      expect(await found({ paths: ["*.ts"] })).toEqual(["web: SHOP-34 Follow the rename", "web: SHOP-12 Show the price"]);
      expect(await found({ since: "2026-10-15" })).toEqual(["web: SHOP-34 Follow the rename", "orders: SHOP-34 Rename price to amount"]);
      expect(await found({ text: "PRICE", ignoreCase: true, paths: ["*.java"] })).toEqual([
        "orders: SHOP-34 Rename price to amount",
        "orders: Add the order DTO",
      ]);
      // With no filter it lists the newest commits.
      expect(await found({ limit: 1 })).toEqual(["web: SHOP-34 Follow the rename"]);
    },
    REPOS_SETUP_MS,
  );

  test(
    "without regex a regular expression character is an ordinary one, with regex it is a POSIX extended regular expression",
    async () => {
      const { workspace } = await workspaceWithHistory();
      const found = async (query: Partial<CommitSearchQuery>) => subjects(await workspace.searchCommits({ ...QUERY, ...query }));

      expect(await found({ message: "SHOP-(12|34)" })).toEqual([]);
      expect(await found({ message: "SHOP-(12|34)", regex: true })).toHaveLength(3);
      // The pickaxe counts occurrences: the rename keeps one match of the expression, so only the commit adding it is found.
      expect(await found({ text: "o\\.(price|amount)", regex: true })).toEqual(["web: SHOP-12 Show the price"]);
    },
    REPOS_SETUP_MS,
  );

  test(
    "a value that starts with a dash stays a value and never becomes a git option",
    async () => {
      const { workspace } = await workspaceWithHistory();

      const result = await workspace.searchCommits({ ...QUERY, text: "--output=/tmp/x", message: "--all", author: "-p" });

      expect(result).toMatchObject({ commits: [], failed: [] });
    },
    REPOS_SETUP_MS,
  );

  test(
    "limit keeps the newest commits across repos and marks the repos that lost commits as truncated",
    async () => {
      const { workspace } = await workspaceWithHistory();

      const result = await workspace.searchCommits({ ...QUERY, text: "price", limit: 2 });

      expect(subjects(result)).toEqual(["web: SHOP-34 Follow the rename", "orders: SHOP-34 Rename price to amount"]);
      expect(result.truncated).toBe(true);
      expect(result.searched.map((r) => [r.repo, r.truncated])).toEqual([
        ["orders", true],
        ["web", true],
      ]);
    },
    REPOS_SETUP_MS,
  );

  test(
    "ids narrow the search, an unknown id is not_found, and an invalid regex puts each repo in failed",
    async () => {
      const { workspace } = await workspaceWithHistory();

      expect(subjects(await workspace.searchCommits({ ...QUERY, message: "SHOP" }, ["orders"]))).toEqual([
        "orders: SHOP-34 Rename price to amount",
      ]);
      await expect(workspace.searchCommits(QUERY, ["missing"])).rejects.toMatchObject({ code: "not_found" });

      const invalid = await workspace.searchCommits({ ...QUERY, message: "(", regex: true });
      expect(invalid.commits).toEqual([]);
      expect(invalid.failed.map((f) => f.repo)).toEqual(["orders", "web"]);
    },
    REPOS_SETUP_MS,
  );

  test("repos not started before the time runs out are skipped, and the result says it is incomplete", async () => {
    const entries = [
      { id: "r1", path: "/repos/r1" },
      { id: "r2", path: "/repos/r2" },
    ];
    const vcs = {
      headCommit: async () => "c".repeat(40),
      searchLog: async () => ({ commits: [], truncated: false }),
    };

    const result = await searchCommits(entries, vcs, QUERY, 0);

    expect(result).toEqual({ commits: [], truncated: true, searched: [], failed: [], skipped: ["r1", "r2"] });
  });

  test("the git output of a merge commit, a commit with files and a file list cut to the limit are read apart", () => {
    const out =
      "\x1e" +
      `${"a".repeat(40)}\x1fAnn\x1f2026-10-20T08:00:00+00:00\x1fMerge branch 'x'\0` +
      "\x1e" +
      `${"b".repeat(40)}\x1fBob\x1f2026-10-19T08:00:00+00:00\x1fTouch files\0\nsrc/a.ts\0src/b.ts\0`;

    expect(parseLogSearch(out)).toEqual([
      { hash: "a".repeat(40), author: "Ann", date: "2026-10-20T08:00:00+00:00", subject: "Merge branch 'x'", files: [] },
      { hash: "b".repeat(40), author: "Bob", date: "2026-10-19T08:00:00+00:00", subject: "Touch files", files: ["src/a.ts", "src/b.ts"] },
    ]);
  });
});

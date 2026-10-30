import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { withTempFolderGone } from "./support/temp-folder.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const vcs = new Vcs(systemTempFolder);

describe("vcs on real git", () => {
  test(
    "a failed worktree creation leaves no branch, so a retry with the same branch succeeds",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n" });
      const commit = gitIn(dir, "rev-parse", "HEAD").trim();
      const path = join(mkdtempSync(join(tmpdir(), "trackwall-worktrees-")), "task");
      mkdirSync(path);
      writeFileSync(join(path, "taken.txt"), "the directory is not empty");

      await expect(vcs.addWorktree(dir, path, "trackwall/task-abc123", commit)).rejects.toThrow();
      expect(gitIn(dir, "branch", "--list", "trackwall/*").trim()).toBe("");
      expect(existsSync(path)).toBe(false);

      await vcs.addWorktree(dir, path, "trackwall/task-abc123", commit);
      expect(gitIn(path, "branch", "--show-current").trim()).toBe("trackwall/task-abc123");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "creating a worktree on a branch that already exists refuses and does not delete the branch",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n" });
      const commit = gitIn(dir, "rev-parse", "HEAD").trim();
      gitIn(dir, "branch", "trackwall/mine");
      const path = join(mkdtempSync(join(tmpdir(), "trackwall-worktrees-")), "task");

      await expect(vcs.addWorktree(dir, path, "trackwall/mine", commit)).rejects.toThrow("a branch named 'trackwall/mine' already exists");
      expect(gitIn(dir, "branch", "--list", "trackwall/mine").trim()).toBe("trackwall/mine");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "status shows the branch, the last commit and uncommitted changes",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n" });
      commitFiles(dir, { "src/app.ts": "export {};\n" }, "Add the app");
      writeFileSync(join(dir, "README.md"), "# repo changed\n");
      writeFileSync(join(dir, "new.txt"), "x");

      const status = await vcs.status(dir, "fresh");

      expect(status).toMatchObject({ kind: "ok", branch: "main", changes: 2, untracked: 1, upstream: null });
      expect(status.head).toMatchObject({ subject: "Add the app", author: "Test Author" });
      expect(status.head?.hash).toMatch(/^[0-9a-f]{40}$/);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test.each(["sha1", "sha256"] as const)(
    "counting changes with new files, including an empty file and an embedded repo, writes no object to the repo (%s)",
    async (objectFormat) => {
      // Writing an object on every count made several "Changes" windows at once write the same empty blob, and on Windows
      // the second write ended in "Permission denied" (#36).
      const dir = makeRepo({ "README.md": "# repo\n" }, "repo", undefined, objectFormat);
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "new.md"), "x\n");
      writeFileSync(join(dir, "empty.md"), "");
      const embeddedHead = gitIn(makeRepo({ "a.txt": "a\n" }, "embedded", dir, objectFormat), "rev-parse", "HEAD").trim();
      makeRepo({}, "embedded-without-commits", dir, objectFormat);
      // A repo with objects in another format cannot be a submodule; `update-index` would reject every entry because of it.
      makeRepo({ "b.txt": "b\n" }, "embedded-in-another-format", dir, objectFormat === "sha1" ? "sha256" : "sha1");
      const objectsBefore = gitIn(dir, "count-objects", "-v");

      const changes = await vcs.worktreeChanges(dir, base, 1_000_000, []);

      expect(changes.files.map((f) => f.path)).toEqual(["embedded", "empty.md", "new.md"]);
      expect(changes.patch).toContain("+x");
      expect(changes.patch).toContain(`+Subproject commit ${embeddedHead}`);
      expect(gitIn(dir, "count-objects", "-v")).toBe(objectsBefore);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform !== "linux")(
    "a new file with a name outside UTF-8 is in the changes (Linux; Windows and macOS have no such names)",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n" });
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(Buffer.concat([Buffer.from(join(dir, "bad-")), Buffer.from([0xff])]), "x\n");

      const changes = await vcs.worktreeChanges(dir, base, 1_000_000, []);

      expect(changes.files).toHaveLength(1);
      expect(changes.patch).toContain("+x");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the status of a repo without commits has an empty HEAD, the log is empty and the tree root is empty",
    async () => {
      const dir = makeRepo();
      expect(await vcs.status(dir, "fresh")).toMatchObject({ kind: "ok", branch: "main", head: null, changes: 0 });
      expect(await vcs.log(dir, 10)).toEqual([]);
      expect(await vcs.tree(dir, "")).toEqual([]);
      expect(await vcs.tree(dir, "src")).toBeUndefined();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "changes shows modified, deleted and new files against HEAD with a diff, without ignored ones and without changing the index",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n", "old.txt": "x\n", ".gitignore": "build/\n" });
      writeFileSync(join(dir, "README.md"), "# repo changed\n");
      rmSync(join(dir, "old.txt"));
      writeFileSync(join(dir, "new.txt"), "new line\n");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "output.txt"), "ignored\n");
      const index = readFileSync(join(dir, ".git", "index"));

      const changes = await vcs.changes(dir, 1024 * 1024);

      expect(changes.files).toEqual([
        { path: "README.md", change: "modified", additions: 1, deletions: 1 },
        { path: "new.txt", change: "added", additions: 1, deletions: 0 },
        { path: "old.txt", change: "deleted", additions: 0, deletions: 1 },
      ]);
      expect(changes.patch).toContain("+# repo changed");
      expect(changes.patch).toContain("+new line");
      expect(changes.truncated).toBe(false);
      expect(readFileSync(join(dir, ".git", "index"))).toEqual(index);
      expect(gitIn(dir, "status", "--porcelain")).toContain("?? new.txt");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "changes in a repo without commits shows every file as new",
    async () => {
      const dir = makeRepo();
      writeFileSync(join(dir, "first.txt"), "a\n");

      expect((await vcs.changes(dir, 1024 * 1024)).files).toEqual([{ path: "first.txt", change: "added", additions: 1, deletions: 0 }]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "ahead/behind against the tracked branch",
    async () => {
      const remote = makeRepo({ "a.txt": "1" }, "remote");
      const parent = join(remote, "..");
      gitIn(parent, "clone", "-q", remote, "clone");
      const clone = join(parent, "clone");
      commitFiles(clone, { "b.txt": "2" }, "local");
      commitFiles(remote, { "c.txt": "3" }, "remote");
      gitIn(clone, "fetch", "-q");

      expect((await vcs.status(clone, "fresh")).upstream).toEqual({ name: "origin/main", ahead: 1, behind: 1 });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "tree lists a directory from the last commit, without uncommitted files",
    async () => {
      const dir = makeRepo({ "src/a.ts": "aa", "src/lib/b.ts": "b", "README.md": "r" });
      writeFileSync(join(dir, "src", "working.ts"), "not in the commit");

      expect(await vcs.tree(dir, "src")).toEqual([
        { name: "lib", path: "src/lib", kind: "dir" },
        { name: "a.ts", path: "src/a.ts", kind: "file", size: 2 },
      ]);
      expect(await vcs.tree(dir, "README.md")).toBeUndefined();
      expect(await vcs.tree(dir, "missing")).toBeUndefined();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "file returns text, recognises a binary file and cuts a large file, giving the full size",
    async () => {
      const dir = makeRepo({
        "a.txt": "zażółć\n",
        "image.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        "large.txt": "x".repeat(5000),
      });

      expect(await vcs.file(dir, "a.txt", 1024)).toEqual({
        kind: "text",
        text: "zażółć\n",
        size: Buffer.byteLength("zażółć\n"),
        truncated: false,
      });
      expect(await vcs.file(dir, "image.png", 1024)).toEqual({ kind: "binary", size: 6 });
      expect(await vcs.file(dir, "large.txt", 100)).toEqual({ kind: "text", text: "x".repeat(100), size: 5000, truncated: true });
      expect(await vcs.file(dir, "missing.txt", 100)).toBeUndefined();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "log returns commits newest first",
    async () => {
      const dir = makeRepo({ "a.txt": "1" });
      commitFiles(dir, { "a.txt": "2" }, "second");
      expect((await vcs.log(dir, 10)).map((c) => c.subject)).toEqual(["second", "first commit"]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a submodule is neither a directory nor a file to read",
    async () => {
      const inner = makeRepo({ "lib.ts": "1" }, "library");
      const dir = makeRepo({ "a.txt": "1" });
      gitIn(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
      gitIn(dir, "commit", "-q", "-m", "submodule");

      expect(((await vcs.tree(dir, "")) ?? []).map((e) => [e.name, e.kind])).toContainEqual(["vendor", "submodule"]);
      expect(await vcs.tree(dir, "vendor")).toBeUndefined();
      expect(await vcs.file(dir, "vendor", 100)).toBeUndefined();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "an inherited GIT_DIR does not replace the repo given with -C",
    async () => {
      const alpha = makeRepo({ "alpha.txt": "a" }, "alpha");
      const beta = makeRepo({ "beta.txt": "b" }, "beta");
      const before = process.env.GIT_DIR;
      process.env.GIT_DIR = join(beta, ".git");
      try {
        expect(((await vcs.tree(alpha, "")) ?? []).map((e) => e.name)).toEqual(["alpha.txt"]);
      } finally {
        if (before === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = before;
      }
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "grepFiles returns files of a commit matching the pattern in the given extensions, and no hits is an empty list, not an error",
    async () => {
      const dir = makeRepo({
        "src/main/java/a/Api.java": "@RestController class Api {}\n",
        "src/main/kotlin/a/Client.kt": '@FeignClient("x") interface Client\n',
        "docs/notes.md": "@RestController in the documentation\n",
        "src/main/java/a/Plain.java": "class Plain {}\n",
      });
      writeFileSync(join(dir, "src", "main", "java", "a", "Plain.java"), "@RestController class Plain {}\n");
      const head = (await vcs.status(dir, "fresh")).head?.hash ?? "";

      const found = await vcs.grepFiles(dir, head, "@(RestController|FeignClient)", ["*.java", "*.kt"], 1024 * 1024);
      expect(found).toEqual({ paths: ["src/main/java/a/Api.java", "src/main/kotlin/a/Client.kt"], truncated: false });
      expect(await vcs.grepFiles(dir, head, "@HttpExchange", ["*.java"], 1024 * 1024)).toEqual({ paths: [], truncated: false });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a missing repo directory is a git error with a message, not a spawn exception",
    async () => {
      await expect(vcs.status(join(makeRepo(), "..", "does-not-exist"), "fresh")).rejects.toThrow(/does-not-exist/);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a same-size edit within the second the index was written is a change, as in git status",
    async () => {
      // Racy git: a file with the size and mtime its index entry records counts as unchanged, unless the index was written
      // no later than that mtime; then git compares the content. The second case is set up here without waiting.
      const dir = makeRepo({ "a.txt": "a = 1\n" }, "racy");
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
      utimesSync(join(dir, "a.txt"), second, second);
      gitIn(dir, "update-index", "--really-refresh");
      utimesSync(join(dir, ".git", "index"), second, second);
      writeFileSync(join(dir, "a.txt"), "a = 2\n");
      utimesSync(join(dir, "a.txt"), second, second);

      const changes = await vcs.worktreeChanges(dir, base, 0, []);
      expect(changes.files).toEqual([{ path: "a.txt", change: "modified", additions: 1, deletions: 1 }]);
      expect(gitIn(dir, "status", "--porcelain")).toBe(" M a.txt\n");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "worktree changes keep their temporary index in the scratch folder, not the system temp folder or .git, and leave nothing behind",
    async () => {
      const dir = makeRepo({ "a.txt": "a\n" }, "no-temp");
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a.txt"), "b\n");
      writeFileSync(join(dir, "new.txt"), "new\n");
      const scratch = join(mkdtempSync(join(tmpdir(), "trackwall-projects-")), "scratch");
      const inProjects = new Vcs(async () => scratch);
      const gitDirBefore = readdirSync(join(dir, ".git"));

      const changes = await withTempFolderGone(() => inProjects.worktreeChanges(dir, base, 0, []));

      expect(changes.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
      expect(readdirSync(scratch)).toEqual([]);
      expect(readdirSync(join(dir, ".git"))).toEqual(gitDirBefore);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("worktree changes do not recreate a projects folder that is gone just to keep their scratch files in it", async () => {
    const dir = makeRepo({ "a.txt": "a\n" }, "projects-gone");
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    const projects = join(mkdtempSync(join(tmpdir(), "trackwall-gone-")), "Dev");
    const inGoneProjects = new Vcs(async () => join(projects, "scratch"));

    await expect(inGoneProjects.worktreeChanges(dir, base, 0, [])).rejects.toThrow();
    expect(existsSync(projects)).toBe(false);
  });

  test(
    "worktree changes with a diff limit of 0 give files and counts without the change contents",
    async () => {
      const dir = makeRepo({ "a.txt": "a\n" }, "no-diff");
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a.txt"), "b\n");
      const changes = await vcs.worktreeChanges(dir, base, 0, []);
      expect(changes).toEqual({
        files: [{ path: "a.txt", change: "modified", additions: 1, deletions: 1 }],
        patch: "",
        truncated: false,
        commits: 0,
        uncommitted: 1,
      });
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

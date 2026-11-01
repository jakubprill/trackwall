import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const vcs = new Vcs(systemTempFolder);
const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
/** Subject and author of each commit, newest first. */
const history = (dir: string, range: string) =>
  gitIn(dir, "log", "--format=%s|%an", range)
    .trim()
    .split("\n")
    .filter((line) => line !== "");

/** A repo whose own config has the user's identity, as the daemon's round commits take it from there. */
function repoWithIdentity(files: Record<string, string>): string {
  const dir = makeRepo(files);
  gitIn(dir, "config", "user.name", "Repo User");
  gitIn(dir, "config", "user.email", "user@example.com");
  return dir;
}

describe("round commits in a task worktree (ADR-168), on real git", () => {
  test(
    "a round commit takes every change, new and deleted files too, under the user's identity, without running the repo's hooks",
    async () => {
      const dir = repoWithIdentity({ "a.txt": "a\n", "b.txt": "b\n" });
      // A hook that would refuse every commit, as an agent could plant one in the worktree.
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
      writeFileSync(join(dir, "a.txt"), "a changed\n");
      writeFileSync(join(dir, "new.txt"), "new\n");
      gitIn(dir, "rm", "-q", "b.txt");
      const before = head(dir);

      expect(await vcs.roundWorktree(dir, "main")).toEqual({ head: before, onBranch: true, uncommitted: 3, operation: null });
      const made = await vcs.commitRound(dir, "WIP round 1");

      expect(made).toBe(head(dir));
      expect(history(dir, `${before}..HEAD`)).toEqual(["WIP round 1|Repo User"]);
      expect(await vcs.roundWorktree(dir, "main")).toEqual({ head: made, onBranch: true, uncommitted: 0, operation: null });
      const round = await vcs.roundChanges(dir, before, made, 1_000_000);
      expect(round.files.map((f) => [f.path, f.change])).toEqual([
        ["a.txt", "modified"],
        ["b.txt", "deleted"],
        ["new.txt", "added"],
      ]);
      expect(round.patch).toContain("+a changed");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the worktree tells a detached HEAD and a merge waiting for the user, which take no round commit",
    async () => {
      const dir = repoWithIdentity({ "a.txt": "a\n" });
      gitIn(dir, "switch", "-q", "-c", "other");
      commitFiles(dir, { "a.txt": "other\n" }, "Change a on other");
      gitIn(dir, "switch", "-q", "main");
      commitFiles(dir, { "a.txt": "main\n" }, "Change a on main");
      expect(() => gitIn(dir, "merge", "-q", "other")).toThrow();

      expect((await vcs.roundWorktree(dir, "main")).operation).toBe("a merge");
      gitIn(dir, "merge", "--abort");
      gitIn(dir, "switch", "-q", "--detach", "HEAD");
      expect(await vcs.roundWorktree(dir, "main")).toMatchObject({ onBranch: false, operation: null });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "undoing a round resets the branch and the files to the round's start, keeps ignored files, and refuses a commit outside HEAD's history",
    async () => {
      const dir = repoWithIdentity({ ".gitignore": "build/\n", "a.txt": "a\n" });
      const start = head(dir);
      writeFileSync(join(dir, "a.txt"), "round\n");
      writeFileSync(join(dir, "added.txt"), "added\n");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "out.bin"), "build output\n");
      await vcs.commitRound(dir, "WIP round 1");
      gitIn(dir, "switch", "-q", "-c", "elsewhere", start);
      commitFiles(dir, { "x.txt": "x\n" }, "Elsewhere");
      const elsewhere = head(dir);
      gitIn(dir, "switch", "-q", "main");

      await expect(vcs.resetRound(dir, elsewhere)).rejects.toThrow("is not in the history of HEAD");
      await vcs.resetRound(dir, start);

      expect(head(dir)).toBe(start);
      expect(existsSync(join(dir, "added.txt"))).toBe(false);
      expect(gitIn(dir, "show", "HEAD:a.txt")).toBe("a\n");
      expect(existsSync(join(dir, "build", "out.bin"))).toBe(true);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the squash folds round commits into the agent's commit after them, keeps its author and message, and turns the last ones into one commit",
    async () => {
      const dir = repoWithIdentity({ "a.txt": "a\n" });
      const base = head(dir);
      writeFileSync(join(dir, "one.txt"), "one\n");
      const round1 = await vcs.commitRound(dir, "WIP round 1");
      commitFiles(dir, { "two.txt": "two\n" }, "Add two");
      writeFileSync(join(dir, "three.txt"), "three\n");
      const round3 = await vcs.commitRound(dir, "WIP round 3");
      writeFileSync(join(dir, "four.txt"), "four\n");
      const round4 = await vcs.commitRound(dir, "WIP round 4");
      const tree = gitIn(dir, "rev-parse", "HEAD^{tree}").trim();

      const squashed = await vcs.squashRounds(dir, "main", base, new Set([round1, round3, round4]), "Add numbers");

      expect(squashed).toBe(head(dir));
      expect(history(dir, `${base}..HEAD`)).toEqual(["Add numbers|Repo User", "Add two|Test Author"]);
      // The same files as before, in the commits and in the working directory.
      expect(gitIn(dir, "rev-parse", "HEAD^{tree}").trim()).toBe(tree);
      expect(gitIn(dir, "show", "--name-only", "--format=", "HEAD~1").trim().split("\n")).toEqual(["one.txt", "two.txt"]);
      expect(gitIn(dir, "status", "--porcelain")).toBe("");
      // Nothing left to squash.
      expect(await vcs.squashRounds(dir, "main", base, new Set([round1, round3, round4]), "Add numbers")).toBeNull();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the squash leaves commits the remote already has, and refuses a history with a merge commit",
    async () => {
      const dir = repoWithIdentity({ "a.txt": "a\n" });
      const base = head(dir);
      writeFileSync(join(dir, "one.txt"), "one\n");
      const pushedRound = await vcs.commitRound(dir, "WIP round 1");
      gitIn(dir, "remote", "add", "origin", "https://example.com/shop.git");
      gitIn(dir, "update-ref", "refs/remotes/origin/main", pushedRound);
      writeFileSync(join(dir, "two.txt"), "two\n");
      const round2 = await vcs.commitRound(dir, "WIP round 2");

      await vcs.squashRounds(dir, "main", base, new Set([pushedRound, round2]), "Add two");
      expect(history(dir, `${base}..HEAD`)).toEqual(["Add two|Repo User", "WIP round 1|Repo User"]);
      expect(gitIn(dir, "rev-parse", "HEAD~1").trim()).toBe(pushedRound);

      gitIn(dir, "switch", "-q", "-c", "side", base);
      commitFiles(dir, { "side.txt": "side\n" }, "Side");
      gitIn(dir, "switch", "-q", "main");
      gitIn(dir, "merge", "-q", "--no-edit", "side");
      writeFileSync(join(dir, "three.txt"), "three\n");
      const round3 = await vcs.commitRound(dir, "WIP round 3");
      const before = head(dir);
      await expect(vcs.squashRounds(dir, "main", base, new Set([round3]), "Add three")).rejects.toThrow("straight history");
      expect(head(dir)).toBe(before);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

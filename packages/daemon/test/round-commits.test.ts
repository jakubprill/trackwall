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

/**
 * A repo whose own config has the user's identity, as the daemon's round commits take it from there, and a task
 * worktree of it on branch `task`, as the task's place for the round functions.
 */
function taskWorktree(files: Record<string, string>) {
  const repoDir = makeRepo(files);
  gitIn(repoDir, "config", "user.name", "Repo User");
  gitIn(repoDir, "config", "user.email", "user@example.com");
  const worktree = join(repoDir, "..", "worktree");
  gitIn(repoDir, "worktree", "add", "-q", "-b", "task", worktree);
  return { place: { worktree, repoDir, branch: "task" }, dir: worktree };
}

describe("round commits in a task worktree (ADR-168), on real git", () => {
  test(
    "a round commit takes every change, new and deleted files too, under the user's identity, without running the repo's hooks",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n", "b.txt": "b\n" });
      // A hook that would refuse every commit, as an agent could plant one.
      const hooks = join(place.repoDir, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(hooks, "pre-commit"), 0o755);
      writeFileSync(join(dir, "a.txt"), "a changed\n");
      writeFileSync(join(dir, "new.txt"), "new\n");
      gitIn(dir, "rm", "-q", "b.txt");
      const before = head(dir);

      expect(await vcs.roundWorktree(place)).toEqual({ head: before, onBranch: true, uncommitted: 3, blocker: null });
      const made = await vcs.commitRound(place, "WIP round 1", []);

      expect(made).toBe(head(dir));
      expect(history(dir, `${before}..HEAD`)).toEqual(["WIP round 1|Repo User"]);
      expect(await vcs.roundWorktree(place)).toEqual({ head: made, onBranch: true, uncommitted: 0, blocker: null });
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
    "files copied into the worktree stay out of a round commit even when a changed .gitignore lets them in",
    async () => {
      const { place, dir } = taskWorktree({ ".gitignore": ".env\n", "a.txt": "a\n" });
      writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
      writeFileSync(join(dir, ".gitignore"), "");
      const before = head(dir);

      const made = await vcs.commitRound(place, "WIP round 1", [".env"]);

      expect(gitIn(dir, "show", "--name-only", "--format=", made).trim()).toBe(".gitignore");
      // With only a kept-out file left, there is nothing to commit, and HEAD stays.
      gitIn(dir, "reset", "-q", "--hard", before);
      writeFileSync(join(dir, ".gitignore"), "");
      gitIn(dir, "commit", "-qam", "Track everything");
      const tracked = head(dir);
      expect(await vcs.commitRound(place, "WIP round 2", [".env"])).toBe(tracked);
      // Nor does one the agent staged itself.
      gitIn(dir, "add", "-f", ".env");
      writeFileSync(join(dir, "a.txt"), "changed\n");
      const third = await vcs.commitRound(place, "WIP round 3", [".env"]);
      expect(gitIn(dir, "show", "--name-only", "--format=", third).trim()).toBe("a.txt");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a worktree whose .git points to another git directory gets no round git at all, whose config could run a program",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n" });
      const planted = makeRepo({ "a.txt": "a\n" });
      writeFileSync(join(dir, ".git"), `gitdir: ${join(planted, ".git")}\n`);
      writeFileSync(join(dir, "a.txt"), "changed\n");

      expect((await vcs.roundWorktree(place)).blocker).toBe(
        "the worktree's .git does not point to a worktree of its repo, so Trackwall does not run git there",
      );
      await expect(vcs.commitRound(place, "WIP round 1", [])).rejects.toThrow("does not point to a worktree of its repo");
      expect(gitIn(planted, "log", "--format=%s").trim()).toBe("first commit");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a worktree whose .git points to another worktree of the same repo is refused too",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n" });
      const other = join(place.repoDir, "..", "other");
      gitIn(place.repoDir, "worktree", "add", "-q", "-b", "other", other);
      writeFileSync(join(dir, ".git"), `gitdir: ${join(place.repoDir, ".git", "worktrees", "other")}\n`);

      expect((await vcs.roundWorktree(place)).blocker).toBe(
        "the worktree's .git does not point to a worktree of its repo, so Trackwall does not run git there",
      );
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the worktree tells a detached HEAD and a merge waiting for the user, which take no round commit",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n" });
      gitIn(dir, "switch", "-q", "-c", "other");
      commitFiles(dir, { "a.txt": "other\n" }, "Change a on other");
      gitIn(dir, "switch", "-q", "task");
      commitFiles(dir, { "a.txt": "task\n" }, "Change a on task");
      expect(() => gitIn(dir, "merge", "-q", "other")).toThrow();

      expect((await vcs.roundWorktree(place)).blocker).toBe("a merge is in progress in the worktree");
      gitIn(dir, "merge", "--abort");
      gitIn(dir, "switch", "-q", "--detach", "HEAD");
      expect(await vcs.roundWorktree(place)).toMatchObject({ onBranch: false, blocker: null });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "undoing a round resets the branch and the files to the round's start and keeps ignored files, only from where the round ended",
    async () => {
      const { place, dir } = taskWorktree({ ".gitignore": "build/\n", "a.txt": "a\n" });
      const start = head(dir);
      writeFileSync(join(dir, "a.txt"), "round\n");
      writeFileSync(join(dir, "added.txt"), "added\n");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "out.bin"), "build output\n");
      const end = await vcs.commitRound(place, "WIP round 1", []);
      gitIn(dir, "switch", "-q", "-c", "elsewhere", start);
      commitFiles(dir, { "x.txt": "x\n" }, "Elsewhere");
      const elsewhere = head(dir);
      gitIn(dir, "switch", "-q", "task");

      await expect(vcs.resetRound(place, end, elsewhere)).rejects.toThrow("is not in the history of HEAD");
      await expect(vcs.resetRound(place, start, start)).rejects.toThrow("the worktree moved since the round was checked");
      await vcs.resetRound(place, end, start);

      expect(head(dir)).toBe(start);
      expect(existsSync(join(dir, "added.txt"))).toBe(false);
      expect(gitIn(dir, "show", "HEAD:a.txt")).toBe("a\n");
      expect(existsSync(join(dir, "build", "out.bin"))).toBe(true);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the squash folds round commits into the agent's commit after them, keeps its author and message, turns the last ones into one commit, and leaves earlier commits as they are",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n" });
      const base = head(dir);
      commitFiles(dir, { "zero.txt": "zero\n" }, "Add zero");
      const untouched = head(dir);
      writeFileSync(join(dir, "one.txt"), "one\n");
      const round1 = await vcs.commitRound(place, "WIP round 1", []);
      commitFiles(dir, { "two.txt": "two\n" }, "Add two");
      writeFileSync(join(dir, "three.txt"), "three\n");
      const round3 = await vcs.commitRound(place, "WIP round 3", []);
      writeFileSync(join(dir, "four.txt"), "four\n");
      const round4 = await vcs.commitRound(place, "WIP round 4", []);
      const before = head(dir);
      const tree = gitIn(dir, "rev-parse", "HEAD^{tree}").trim();

      const squashed = await vcs.squashRounds(place, base, new Set([round1, round3, round4]), "Add numbers");
      if (squashed === null) throw new Error("nothing was squashed");

      // Only objects are written: the branch moves when the caller says so, from where the squash read it.
      expect(squashed.from).toBe(before);
      expect(head(dir)).toBe(before);
      await vcs.moveBranch(place, squashed);
      expect(head(dir)).toBe(squashed.to);
      expect(history(dir, `${base}..HEAD`)).toEqual(["Add numbers|Repo User", "Add two|Test Author", "Add zero|Test Author"]);
      expect(gitIn(dir, "rev-parse", "HEAD~2").trim()).toBe(untouched);
      expect(gitIn(dir, "rev-parse", "HEAD^{tree}").trim()).toBe(tree);
      expect(gitIn(dir, "show", "--name-only", "--format=", "HEAD~1").trim().split("\n")).toEqual(["one.txt", "two.txt"]);
      expect(gitIn(dir, "status", "--porcelain")).toBe("");
      expect(await vcs.squashRounds(place, base, new Set([round1, round3, round4]), "Add numbers")).toBeNull();
      // A second move from the old commit is refused: the branch is not where that squash read it.
      await expect(vcs.moveBranch(place, squashed)).rejects.toThrow();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the squash leaves commits the remote already has and everything up to the branch's last merge",
    async () => {
      const { place, dir } = taskWorktree({ "a.txt": "a\n" });
      const base = head(dir);
      writeFileSync(join(dir, "one.txt"), "one\n");
      const pushedRound = await vcs.commitRound(place, "WIP round 1", []);
      gitIn(dir, "remote", "add", "origin", "https://example.com/shop.git");
      gitIn(dir, "update-ref", "refs/remotes/origin/task", pushedRound);
      gitIn(dir, "switch", "-q", "-c", "side", base);
      commitFiles(dir, { "side.txt": "side\n" }, "Side");
      gitIn(dir, "switch", "-q", "task");
      writeFileSync(join(dir, "two.txt"), "two\n");
      const beforeMerge = await vcs.commitRound(place, "WIP round 2", []);
      gitIn(dir, "merge", "-q", "--no-edit", "side");
      const merge = head(dir);
      writeFileSync(join(dir, "three.txt"), "three\n");
      const round3 = await vcs.commitRound(place, "WIP round 3", []);

      const squashed = await vcs.squashRounds(place, base, new Set([pushedRound, beforeMerge, round3]), "Add three");
      if (squashed === null) throw new Error("nothing was squashed");
      await vcs.moveBranch(place, squashed);

      expect(gitIn(dir, "log", "-1", "--format=%s", "HEAD").trim()).toBe("Add three");
      expect(gitIn(dir, "rev-parse", "HEAD~1").trim()).toBe(merge);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

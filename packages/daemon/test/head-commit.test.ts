import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packedRef, readHeadCommit } from "../src/modules/vcs/head-commit.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const headOf = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();

/** A new empty repo with the reftable backend; `undefined` when this git does not have it. */
function reftableRepo(): string | undefined {
  const repo = join(mkdtempSync(join(tmpdir(), "trackwall-git-")), "repo");
  try {
    gitIn(tmpdir(), "init", "-q", "-b", "main", "--ref-format=reftable", repo);
    return repo;
  } catch {
    return undefined;
  }
}

describe("readHeadCommit", () => {
  test("a branch in its own ref file gives the commit git gives", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
  });

  test("a branch packed into packed-refs, and a new commit on it after that", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    gitIn(repo, "pack-refs", "--all");
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
    commitFiles(repo, { "b.txt": "b" }, "second");
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
  });

  test("a detached HEAD", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    commitFiles(repo, { "b.txt": "b" }, "second");
    gitIn(repo, "checkout", "-q", "--detach", "HEAD~1");
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
  });

  test("a branch without commits is null", async () => {
    expect(await readHeadCommit(makeRepo())).toBeNull();
  });

  test("a worktree reads its own HEAD and the shared refs", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-wt-")), "wt");
    gitIn(repo, "worktree", "add", "-q", "-b", "task", worktree);
    commitFiles(worktree, { "c.txt": "c" }, "on the task branch");
    expect(await readHeadCommit(worktree)).toBe(headOf(worktree));
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
  });

  test("SHA-256 objects", async () => {
    const repo = makeRepo({ "a.txt": "a" }, "repo", undefined, "sha256");
    expect(await readHeadCommit(repo)).toBe(headOf(repo));
  });

  // Git before 2.45 has no reftable backend (the git of Xcode on macOS runners).
  test.if(reftableRepo() !== undefined)("the reftable backend is left to git", async () => {
    const repo = reftableRepo();
    if (repo === undefined) throw new Error("git without reftable");
    commitFiles(repo, { "a.txt": "a" }, "first commit");
    expect(await readHeadCommit(repo)).toBeUndefined();
  });

  test("a HEAD whose ref leads out of the git directory is left to git", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs\\..\\..\\outside\n");
    expect(await readHeadCommit(repo)).toBeUndefined();
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/../../outside\n");
    expect(await readHeadCommit(repo)).toBeUndefined();
  });

  test("a directory without a git directory is left to git", async () => {
    expect(await readHeadCommit(mkdtempSync(join(tmpdir(), "trackwall-plain-")))).toBeUndefined();
  });
});

describe("packedRef", () => {
  test("finds the ref among the lines and skips the header and peeled tags", () => {
    const packed = [
      "# pack-refs with: peeled fully-peeled sorted ",
      `${"1".repeat(40)} refs/heads/main`,
      `${"2".repeat(40)} refs/tags/v1`,
      `^${"3".repeat(40)}`,
      "",
    ].join("\n");
    expect(packedRef(packed, "refs/heads/main")).toBe("1".repeat(40));
    expect(packedRef(packed, "refs/heads/other")).toBeUndefined();
  });
});

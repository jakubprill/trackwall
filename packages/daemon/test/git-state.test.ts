import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

async function stateOf(vcs: Vcs, repo: string) {
  return (await vcs.gitStates([repo])).get(repo);
}

describe("git state from the files of the git directory", () => {
  test("a commit and a checkout move HEAD, a new branch and a ref from a fetch change only the refs, git status changes nothing", async () => {
    const vcs = new Vcs();
    const repo = makeRepo({ "a.txt": "1" });
    const start = await stateOf(vcs, repo);

    gitIn(repo, "status");
    writeFileSync(join(repo, "a.txt"), "uncommitted");
    gitIn(repo, "status");
    expect(await stateOf(vcs, repo)).toEqual(start);

    commitFiles(repo, { "a.txt": "2" }, "second");
    const committed = await stateOf(vcs, repo);
    expect(committed?.head).not.toBe(start?.head);

    gitIn(repo, "branch", "feature/x");
    const branched = await stateOf(vcs, repo);
    expect(branched?.head).toBe(committed?.head);
    expect(branched?.refs).not.toBe(committed?.refs);

    gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const fetched = await stateOf(vcs, repo);
    expect(fetched?.head).toBe(branched?.head);
    expect(fetched?.refs).not.toBe(branched?.refs);

    gitIn(repo, "checkout", "-q", "feature/x");
    expect((await stateOf(vcs, repo))?.head).not.toBe(fetched?.head);
  });

  test("a ref directory created in the same second as the previous listing is still found on a file system with whole-second times", async () => {
    const vcs = new Vcs();
    const repo = makeRepo({ "a.txt": "1" });
    const heads = join(repo, ".git", "refs", "heads");
    const second = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(heads, second, second);
    const before = await stateOf(vcs, repo);

    mkdirSync(join(heads, "feature"));
    utimesSync(heads, second, second);
    await stateOf(vcs, repo);
    gitIn(repo, "branch", "feature/x");
    utimesSync(heads, second, second);

    expect((await stateOf(vcs, repo))?.refs).not.toBe(before?.refs);
  });

  test("a worktree's HEAD is its own, and its commit is seen", async () => {
    const vcs = new Vcs();
    const repo = makeRepo({ "a.txt": "1" });
    const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-wt-")), "wt");
    gitIn(repo, "worktree", "add", "-q", "-b", "task", worktree);
    const before = await stateOf(vcs, worktree);
    expect(before).not.toBeNull();

    commitFiles(worktree, { "b.txt": "1" }, "in the worktree");

    expect((await stateOf(vcs, worktree))?.head).not.toBe(before?.head);
  });

  test("a directory without a readable git directory has no state", async () => {
    const vcs = new Vcs();
    const dir = mkdtempSync(join(tmpdir(), "trackwall-nogit-"));
    expect(await stateOf(vcs, dir)).toBeNull();
    writeFileSync(join(dir, ".git"), "gitdir: ../nowhere\n");
    expect(await stateOf(vcs, dir)).toBeNull();
  });
});

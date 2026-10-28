import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const vcs = new Vcs();
const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
const MISSING = "0123456789abcdef0123456789abcdef01234567";

describe("the commits between two day starts, on real git", () => {
  test(
    "the commits a newer commit has: how many and the newest first, up to the limit",
    async () => {
      const dir = makeRepo({ "a.txt": "a" });
      const from = head(dir);
      commitFiles(dir, { "b.txt": "b" }, "Add b");
      commitFiles(dir, { "c.txt": "c" }, "Add c");
      commitFiles(dir, { "d.txt": "d" }, "Add d");

      const range = await vcs.commitsBetween(dir, from, head(dir), 2);
      expect(range?.total).toBe(3);
      expect(range?.commits.map((c) => c.subject)).toEqual(["Add d", "Add c"]);
      expect(await vcs.countBetween(dir, from, head(dir))).toBe(3);
      expect((await vcs.newestCommits(dir, head(dir), 1)).map((c) => c.subject)).toEqual(["Add d"]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "an older commit is an ancestor; a commit from a rewritten branch and one not in the repo are not",
    async () => {
      const dir = makeRepo({ "a.txt": "a" });
      const first = head(dir);
      commitFiles(dir, { "b.txt": "b" }, "Add b");
      const second = head(dir);
      gitIn(dir, "reset", "-q", "--hard", first);
      commitFiles(dir, { "c.txt": "c" }, "Add c");

      expect(await vcs.isAncestor(dir, first, head(dir))).toBe(true);
      expect(await vcs.isAncestor(dir, second, head(dir))).toBe(false);
      expect(await vcs.isAncestor(dir, MISSING, head(dir))).toBe(false);
      expect(await vcs.commitsBetween(dir, MISSING, head(dir), 5)).toBeUndefined();
      expect(await vcs.countBetween(dir, MISSING, head(dir))).toBeUndefined();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a git failure is an error, not a missing commit, so the day start keeps its old commit",
    async () => {
      const notARepo = mkdtempSync(join(tmpdir(), "trackwall-not-a-repo-"));

      await expect(vcs.isAncestor(notARepo, MISSING, MISSING)).rejects.toThrow();
      await expect(vcs.commitsBetween(notARepo, MISSING, MISSING, 5)).rejects.toThrow();
      await expect(vcs.countBetween(notARepo, MISSING, MISSING)).rejects.toThrow();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the remote default branch is the one the remote's HEAD names, with its commit",
    async () => {
      const server = makeRepo({ "a.txt": "a" }, "server");
      const clone = join(mkdtempSync(join(tmpdir(), "trackwall-clone-")), "clone");
      gitIn(tmpdir(), "clone", "-q", server, clone);

      expect(await vcs.remoteDefaultBranch(clone)).toEqual({ name: "origin/main", commit: head(server) });
      expect(await vcs.remoteDefaultBranch(server)).toBeNull();
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

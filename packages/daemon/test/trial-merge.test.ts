import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictedPaths, trialMergeConflicts } from "../src/modules/vcs/trial-merge.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const LINES = "one\ntwo\nthree\nfour\nfive\nsix\n";

/** A repo with branches `a` and `b` from one commit, each with `a` and `b` committed on top. */
function twoBranches(a: Record<string, string>, b: Record<string, string>, objectFormat: "sha1" | "sha256" = "sha1"): string {
  const dir = makeRepo({ "list.txt": LINES }, "repo", undefined, objectFormat);
  gitIn(dir, "branch", "a");
  gitIn(dir, "branch", "b");
  gitIn(dir, "switch", "-q", "a");
  commitFiles(dir, a, "a");
  gitIn(dir, "switch", "-q", "b");
  commitFiles(dir, b, "b");
  gitIn(dir, "switch", "-q", "main");
  return dir;
}

describe("trial merge of two branches", () => {
  test("edits of the same line conflict, edits of distant lines and of different files do not", async () => {
    const dir = twoBranches(
      { "list.txt": LINES.replace("two", "TWO"), "a.txt": "a\n" },
      { "list.txt": LINES.replace("two", "2").replace("six", "6"), "b.txt": "b\n" },
    );
    expect(await trialMergeConflicts(dir, "a", "b", mkdtempSync(join(tmpdir(), "trackwall-scratch-")))).toEqual(["list.txt"]);

    const apart = twoBranches({ "list.txt": LINES.replace("one", "ONE") }, { "list.txt": LINES.replace("six", "SIX") });
    expect(await trialMergeConflicts(apart, "a", "b", mkdtempSync(join(tmpdir(), "trackwall-scratch-")))).toEqual([]);
  });

  test("a new file both branches add with different content conflicts, in a sha256 repo too", async () => {
    const dir = twoBranches({ "new.txt": "from a\n" }, { "new.txt": "from b\n" }, "sha256");
    expect(await trialMergeConflicts(dir, "a", "b", mkdtempSync(join(tmpdir(), "trackwall-scratch-")))).toEqual(["new.txt"]);
  });

  test("the repo gets no objects and the scratch folder is left empty", async () => {
    const dir = twoBranches({ "list.txt": LINES.replace("two", "TWO") }, { "list.txt": LINES.replace("two", "2") });
    const scratch = mkdtempSync(join(tmpdir(), "trackwall-scratch-"));
    const before = gitIn(dir, "count-objects", "-v");

    expect(await trialMergeConflicts(dir, "a", "b", scratch)).toEqual(["list.txt"]);
    expect(gitIn(dir, "count-objects", "-v")).toBe(before);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a merge driver the repo's own config names does not run", async () => {
    const dir = twoBranches(
      { "list.txt": LINES.replace("two", "TWO"), ".gitattributes": "*.txt merge=take\n" },
      { "list.txt": LINES.replace("two", "2"), ".gitattributes": "*.txt merge=take\n" },
    );
    // A driver that would resolve every conflict (and could be any program an agent wrote into the repo's config).
    gitIn(dir, "config", "merge.take.driver", "true");
    expect(await trialMergeConflicts(dir, "a", "b", mkdtempSync(join(tmpdir(), "trackwall-scratch-")))).toEqual(["list.txt"]);
  });

  test("a branch that is gone gives no answer instead of a failure", async () => {
    const dir = twoBranches({ "a.txt": "a\n" }, { "b.txt": "b\n" });
    expect(await trialMergeConflicts(dir, "a", "gone", mkdtempSync(join(tmpdir(), "trackwall-scratch-")))).toBeNull();
  });

  test("git's output names each conflicted path once and stops at the empty entry", () => {
    expect(conflictedPaths("4b825dc\0src/a.ts\0src/a.ts\0b.ts\0\0")).toEqual(["src/a.ts", "b.ts"]);
    expect(conflictedPaths("4b825dc\0")).toEqual([]);
  });
});

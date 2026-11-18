import { describe, expect, test } from "bun:test";
import type { BatchRun, PullResult, PutAside } from "@trackwall/protocol";
import { putAsideLabel, putAsideResultLine, reposSkippedForChanges } from "../src/lib/put-aside.ts";

const AT = "2026-11-18T10:00:00.000Z";

describe("which repos of a batch command can put their changes aside", () => {
  test("only a sync skipped for changed files counts, not a diverged branch or a skipped mise task", () => {
    const run: BatchRun = {
      startedAt: AT,
      finishedAt: AT,
      cancelled: false,
      repos: [
        {
          repo: "orders",
          path: "/p/orders",
          steps: [{ step: "sync", state: "skipped", message: "main is checked out and has uncommitted changes", syncReason: "dirty" }],
        },
        {
          repo: "catalog",
          path: "/p/catalog",
          steps: [{ step: "sync", state: "skipped", message: "main has diverged", syncReason: "diverged" }],
        },
        {
          repo: "billing",
          path: "/p/billing",
          steps: [
            { step: "sync", state: "done", detail: "main +2" },
            { step: "setup", state: "skipped", message: "the repo has no mise task setup", syncReason: null },
          ],
        },
      ],
    };
    expect(reposSkippedForChanges(run)).toEqual(["orders"]);
  });
});

describe("the words for a put-aside", () => {
  const putAside: PutAside = { id: "a".repeat(40), branch: "main", at: AT, files: ["pom.xml", "README.md", "app.yml"] };

  test("the result says what was put aside before what the pull did", () => {
    const result: PullResult = {
      defaultBranch: { state: "updated", branch: "main", remoteBranch: "origin/main", commits: 41 },
      checkedOut: null,
      workingTree: null,
      putAside,
    };
    expect(putAsideResultLine(result)).toEqual({ tone: "ok", label: "Put aside 3 files · Pulled 41 commits into main" });
  });

  test("a pull that could not move the branch put nothing aside and says only why", () => {
    const result: PullResult = {
      defaultBranch: {
        state: "skipped",
        reason: "diverged",
        message: "main has diverged from the remote (1 local, 6 remote); merge by hand",
      },
      checkedOut: null,
      workingTree: null,
      putAside: null,
    };
    expect(putAsideResultLine(result)).toEqual({
      tone: "warning",
      label: "Main has diverged from the remote (1 local, 6 remote); merge by hand",
    });
  });

  test("the Changes tab names the files, the branch and when", () => {
    expect(putAsideLabel(putAside, new Date("2026-11-18T12:00:00.000Z"))).toBe("3 files on main, put aside 2 h ago");
    expect(putAsideLabel({ ...putAside, branch: null, files: ["a"] }, new Date("2026-11-18T10:00:30.000Z"))).toMatch(/^1 file, put aside /);
  });
});

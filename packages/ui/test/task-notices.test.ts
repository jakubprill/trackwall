import { describe, expect, test } from "bun:test";
import type { Verification } from "@trackwall/protocol";
import { newWarnings, type TaskNoticeInput, taskNotices, tileNotices } from "../src/lib/task-notices.ts";

const quiet: TaskNoticeInput = {
  task: { included: { files: [], problems: [] }, summary: null },
  messages: [],
  sharedWith: [],
  miseConfig: { neverTrusted: false, changes: [], digest: "d0" },
  verification: null,
  mergeRequest: false,
  miseRuns: [],
};
const verification = (state: Verification["state"]): Verification => ({
  task: "t1",
  repo: "shop",
  miseTask: "test",
  state,
  runId: "r1",
  startedAt: "2026-10-27T06:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  message: null,
  tests: null,
  failures: [],
  errors: [],
  lastLines: [],
});

describe("taskNotices", () => {
  test("a task with nothing to say above its terminal has no notices", () => {
    expect(taskNotices(quiet)).toEqual([]);
  });

  test("warnings come first, then the other notices in the order of the panel's sections", () => {
    const notices = taskNotices({
      task: {
        included: { files: [".env"], problems: [] },
        summary: { text: "Added a discount.", reportedAt: "2026-10-27T06:00:00.000Z" },
      },
      messages: [{ readAt: "2026-10-27T06:01:00.000Z" }, { readAt: null }],
      sharedWith: [{ task: "t2", name: "Extend add()", files: 2 }],
      miseConfig: { neverTrusted: false, changes: [{ path: "mise.toml", change: "modified", content: "" }], digest: "d1" },
      verification: verification("failed"),
      mergeRequest: true,
      miseRuns: ["dev"],
    });
    expect(notices.map((n) => [n.section, n.tone, n.label])).toEqual([
      ["shared-files", "warning", "2 files also in “Extend add()”"],
      ["mise-config", "warning", "The agent changed the mise config"],
      ["included", "info", "1 included file"],
      ["messages", "info", "2 messages, 1 not read"],
      ["summary", "info", "Summary"],
      ["verification", "failed", "Verification failed"],
      ["merge-request", "info", "Merge request"],
      ["mise-runs", "running", "dev running"],
    ]);
  });

  test("a mise config that was never trusted, or where mise cannot run, is a warning of its own", () => {
    const never = taskNotices({
      ...quiet,
      miseConfig: { neverTrusted: true, changes: [{ path: "mise.toml", change: "added", content: "" }], digest: "d1" },
    });
    expect(never.map((n) => n.label)).toEqual(["mise config not trusted yet"]);
    expect(taskNotices({ ...quiet, miseConfig: "unavailable" }).map((n) => [n.tone, n.label])).toEqual([
      ["warning", "mise tasks cannot run here"],
    ]);
  });

  test("files the worktree could not copy are a warning", () => {
    const notices = taskNotices({ ...quiet, task: { ...quiet.task, included: { files: [], problems: [".env: too large"] } } });
    expect(notices.map((n) => [n.tone, n.label])).toEqual([["warning", "1 file not copied"]]);
  });

  test("the verification says how it went", () => {
    expect(taskNotices({ ...quiet, verification: verification("running") })[0]).toMatchObject({ tone: "running", label: "Verifying" });
    expect(taskNotices({ ...quiet, verification: verification("passed") })[0]).toMatchObject({
      tone: "passed",
      label: "Verification passed",
    });
  });

  test("a mise config changed again is a new warning: its key carries the config's digest", () => {
    const changed = (digest: string) =>
      taskNotices({
        ...quiet,
        miseConfig: { neverTrusted: false, changes: [{ path: "mise.toml", change: "modified", content: "" }], digest },
      });
    expect(changed("d1")[0]?.key).not.toBe(changed("d2")[0]?.key);
  });
});

describe("newWarnings", () => {
  const notices = taskNotices({
    ...quiet,
    task: { ...quiet.task, summary: { text: "Done.", reportedAt: "2026-10-27T06:00:00.000Z" } },
    sharedWith: [
      { task: "t2", name: "Extend add()", files: 1 },
      { task: "t3", name: "Rename cart", files: 3 },
    ],
  });

  test("are the warnings not seen yet, never the other notices", () => {
    expect(newWarnings(notices, new Set(["shared-files:t2"])).map((n) => n.key)).toEqual(["shared-files:t3"]);
    expect(newWarnings(notices, new Set(["shared-files:t2", "shared-files:t3"]))).toEqual([]);
  });
});

describe("tileNotices", () => {
  const changedConfig = { neverTrusted: false, changes: [{ path: "mise.toml", change: "modified" as const, content: "" }], digest: "d1" };

  test("a mise config to trust and a finished verification get chips of their own, the rest stays on the badge", () => {
    const tile = tileNotices(
      taskNotices({
        ...quiet,
        miseConfig: changedConfig,
        verification: verification("failed"),
        sharedWith: [{ task: "t2", name: "Extend add()", files: 1 }],
        mergeRequest: true,
      }),
    );
    expect(tile.chips.map((n) => n.chip)).toEqual(["Trust mise", "Failed"]);
    expect(tile.others.map((n) => n.label)).toEqual(["1 file also in “Extend add()”", "Merge request"]);
  });

  test("mise that cannot run in the worktree keeps its chip, without asking for trust", () => {
    expect(tileNotices(taskNotices({ ...quiet, miseConfig: "unavailable" })).chips.map((n) => n.chip)).toEqual(["mise"]);
  });

  test("a running verification has a chip, a cancelled one stays on the badge", () => {
    expect(tileNotices(taskNotices({ ...quiet, verification: verification("running") })).chips.map((n) => n.chip)).toEqual(["Verifying"]);
    const cancelled = tileNotices(taskNotices({ ...quiet, verification: verification("cancelled") }));
    expect(cancelled.chips).toEqual([]);
    expect(cancelled.others.map((n) => n.label)).toEqual(["Verification cancelled"]);
  });

  test("a task with nothing to say has no chips and nothing on the badge", () => {
    expect(tileNotices(taskNotices(quiet))).toEqual({ chips: [], others: [] });
  });
});

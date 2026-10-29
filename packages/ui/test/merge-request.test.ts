import { describe, expect, test } from "bun:test";
import { MERGE_REQUEST_DESCRIPTION_MAX, type Task, type TaskBranchPush, type Verification } from "@trackwall/protocol";
import {
  branchPushLabel,
  canPush,
  mergeRequestDraft,
  mergeRequestNumber,
  mergeRequestStateLabel,
  pipelineLabel,
} from "../src/lib/merge-request.ts";

const task = (fields: Partial<Task> = {}): Task => ({
  id: "t1",
  repo: "shop",
  prompt: "Add a 10% discount to the cart\nand show it on the receipt",
  branch: "trackwall/add-a-discount-1a2b3c",
  baseBranch: "main",
  base: "a".repeat(40),
  worktree: "/w/shop/add-a-discount-1a2b3c",
  createdAt: "2026-10-26T09:00:00Z",
  title: null,
  proposedBy: null,
  model: null,
  approvals: "ask",
  javaNavigation: false,
  summary: null,
  port: 41000,
  included: { files: [], problems: [] },
  ...fields,
});

const verification = (state: Verification["state"], tests: Verification["tests"] = null): Verification => ({
  task: "t1",
  repo: "shop",
  miseTask: "test",
  state,
  runId: "r1",
  startedAt: "2026-10-26T10:00:00Z",
  finishedAt: state === "running" ? null : "2026-10-26T10:01:00Z",
  exitCode: state === "passed" ? 0 : 1,
  message: null,
  tests,
  failures: [],
  errors: [],
  lastLines: [],
});

const push = (fields: Partial<TaskBranchPush>): TaskBranchPush => ({
  remote: "origin",
  commits: 2,
  published: true,
  unpushed: 0,
  behind: 0,
  uncommitted: 0,
  ...fields,
});

describe("the merge request draft", () => {
  test("takes the agent's summary and the verdict with its test counts, and the first line of the prompt as the title", () => {
    const tests = {
      totals: { tests: 128, failures: 0, errors: 0, skipped: 3, timeSeconds: 12 },
      reports: 4,
      unreadReports: 0,
      earlierReports: 0,
      truncated: false,
    };
    const draft = mergeRequestDraft(
      task({ summary: { text: "Added the discount and a test.\n", reportedAt: "2026-10-26T10:02:00Z" } }),
      verification("passed", tests),
    );

    expect(draft).toEqual({
      title: "Add a 10% discount to the cart",
      description: "Added the discount and a test.\n\nVerification in Trackwall: passed (mise task test, 128 tests · 3 skipped)",
    });
  });

  test("a task's own title wins, the prompt stands in for a missing summary, and a running verification is left out", () => {
    expect(mergeRequestDraft(task({ title: "Discount in the cart" }), verification("running"))).toEqual({
      title: "Discount in the cart",
      description: "Add a 10% discount to the cart\nand show it on the receipt",
    });
    expect(mergeRequestDraft(task(), verification("failed")).description).toEndWith(
      "\n\nVerification in Trackwall: failed (mise task test)",
    );
  });

  test("a long summary is cut to what the form's address carries", () => {
    const draft = mergeRequestDraft(task({ summary: { text: "x".repeat(10_000), reportedAt: "2026-10-26T10:02:00Z" } }), null);

    expect(draft.description).toHaveLength(MERGE_REQUEST_DESCRIPTION_MAX);
    expect(draft.description.endsWith("…")).toBe(true);
  });
});

describe("the task branch against the remote", () => {
  test("says what is pushed, what is not, and what the remote has that the task does not", () => {
    expect(branchPushLabel(push({ published: false, unpushed: 2 }))).toBe("2 commits · not pushed yet");
    expect(branchPushLabel(push({ unpushed: 1, uncommitted: 3 }))).toBe("2 commits · 1 not pushed · 3 files not committed");
    expect(branchPushLabel(push({ behind: 1 }))).toBe("2 commits · pushed · the remote has 1 commit the task does not");
  });

  test("Push has something to send only with commits the remote lacks", () => {
    expect(canPush(push({ published: false, unpushed: 2 }))).toBe(true);
    expect(canPush(push({ unpushed: 1 }))).toBe(true);
    expect(canPush(push({}))).toBe(false);
    expect(canPush(push({ commits: 0, published: false }))).toBe(false);
  });
});

describe("the merge request and its pipeline", () => {
  test("are numbered as each repo host writes them", () => {
    expect(mergeRequestNumber({ kind: "gitlab", host: "gitlab.example.com", path: "shop/shop" }, 12)).toBe("!12");
    expect(mergeRequestNumber({ kind: "github", host: "github.com", path: "me/shop" }, 7)).toBe("#7");
  });

  test("a merge and a passed pipeline are good, a failed pipeline is an error, and a closed one has no tone", () => {
    expect(mergeRequestStateLabel("merged")).toEqual({ tone: "ok", label: "merged" });
    expect(mergeRequestStateLabel("closed")).toEqual({ label: "closed" });
    expect(pipelineLabel("passed")).toEqual({ tone: "ok", label: "pipeline passed" });
    expect(pipelineLabel("failed")).toEqual({ tone: "error", label: "pipeline failed" });
    expect(pipelineLabel("manual")).toEqual({ tone: "warning", label: "pipeline waits for a manual job" });
  });
});

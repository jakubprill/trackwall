import { describe, expect, test } from "bun:test";
import { MERGE_REQUEST_DESCRIPTION_MAX, type Task, type TaskBranchPush, type Verification } from "@trackwall/protocol";
import {
  branchPushLabel,
  canFixPipeline,
  canPush,
  jobLogNote,
  mergeRequestDraft,
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
  plan: null,
  javaNavigation: false,
  sandbox: false,
  item: null,
  view: "terminal",
  summary: null,
  inReview: false,
  port: 41000,
  included: { files: [], problems: [] },
  change: null,
  retryOf: null,
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
  outdated: false,
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

/** The draft of a task that is no part of a change, without the daemon's evidence. */
const draftOf = (t: Task, v: Verification | null) => mergeRequestDraft({ task: t, verification: v, evidence: null, changeBlock: null });

describe("the merge request draft", () => {
  test("takes the agent's summary and the verdict with its test counts, and the first line of the prompt as the title", () => {
    const tests = {
      totals: { tests: 128, failures: 0, errors: 0, skipped: 3, timeSeconds: 12 },
      reports: 4,
      unreadReports: 0,
      earlierReports: 0,
      truncated: false,
    };
    const draft = mergeRequestDraft({
      task: task({
        summary: { text: "Added the discount and a test.\n", checkSteps: [], reproTest: null, reportedAt: "2026-10-26T10:02:00Z" },
      }),
      verification: verification("passed", tests),
      evidence: null,
      changeBlock: null,
    });

    expect(draft).toEqual({
      title: "Add a 10% discount to the cart",
      description:
        "Added the discount and a test.\n\nEvidence from Trackwall:\n- Verification: passed (mise task test, 128 tests · 3 skipped)",
    });
  });

  test("a task's own title wins, the prompt stands in for a missing summary, and a running verification is left out", () => {
    expect(draftOf(task({ title: "Discount in the cart" }), verification("running"))).toEqual({
      title: "Discount in the cart",
      description: "Add a 10% discount to the cart\nand show it on the receipt",
    });
    expect(draftOf(task(), verification("failed")).description).toEndWith(
      "\n\nEvidence from Trackwall:\n- Verification: failed (mise task test)",
    );
  });

  test("an outdated verdict says it is about an earlier version of the changes (ADR-209)", () => {
    expect(draftOf(task(), { ...verification("passed"), outdated: true }).description).toEndWith(
      "\n- Verification: passed on an earlier version of the changes (mise task test)",
    );
  });

  test("the agent's reproduction test follows the summary as its own claim, before the verdict (ADR-222)", () => {
    const draft = draftOf(
      task({
        summary: {
          text: "Fixed the total of an empty order.",
          checkSteps: [],
          reproTest: {
            file: "src/test/java/com/example/shop/OrderServiceTest.java",
            name: "OrderServiceTest#totalOfEmptyOrder",
            failure: "NullPointerException at OrderService.java:42",
          },
          reportedAt: "2026-10-26T10:02:00Z",
        },
      }),
      verification("passed"),
    );

    expect(draft.description).toBe(
      "Fixed the total of an empty order.\n\nEvidence from Trackwall:\n" +
        "- Reproduction test (the agent's word): OrderServiceTest#totalOfEmptyOrder in src/test/java/com/example/shop/OrderServiceTest.java, " +
        "failed before the fix with: NullPointerException at OrderService.java:42" +
        "\n- Verification: passed (mise task test)",
    );
  });

  test("the agent's check steps follow the summary as a numbered list, before the verdict (ADR-169)", () => {
    const draft = draftOf(
      task({
        summary: {
          text: "Added the discount.",
          checkSteps: ["Open /cart with two items: the total shows -10%", "Remove an item: the discount stays"],
          reproTest: null,
          reportedAt: "2026-10-26T10:02:00Z",
        },
      }),
      verification("passed"),
    );

    expect(draft.description).toBe(
      "Added the discount.\n\nHow to check:\n1. Open /cart with two items: the total shows -10%\n2. Remove an item: the discount stays" +
        "\n\nEvidence from Trackwall:\n- Verification: passed (mise task test)",
    );
  });

  test("a long summary is cut to what the form's address carries", () => {
    const draft = draftOf(
      task({ summary: { text: "x".repeat(10_000), checkSteps: [], reproTest: null, reportedAt: "2026-10-26T10:02:00Z" } }),
      null,
    );

    expect(draft.description).toHaveLength(MERGE_REQUEST_DESCRIPTION_MAX);
    expect(draft.description.endsWith("…")).toBe(true);
  });

  test("a part of a change starts with its change block, and a long summary is cut to keep it whole (ADR-172)", () => {
    const block = "This merge request is part 2 of a change across several repos.";
    const draft = mergeRequestDraft({
      task: task({ summary: { text: "x".repeat(10_000), checkSteps: [], reproTest: null, reportedAt: "2026-10-26T10:02:00Z" } }),
      verification: null,
      evidence: null,
      changeBlock: block,
    });

    expect(draft.description.startsWith(`${block}\n\nxxx`)).toBe(true);
    expect(draft.description).toHaveLength(MERGE_REQUEST_DESCRIPTION_MAX);
    expect(draft.description.endsWith("…")).toBe(true);
  });

  test("a change block longer than the description allows is cut like any text, without the summary", () => {
    const draft = mergeRequestDraft({ task: task({ summary: null }), verification: null, evidence: null, changeBlock: "y".repeat(10_000) });

    expect(draft.description).toBe(`${"y".repeat(MERGE_REQUEST_DESCRIPTION_MAX - 1)}…`);
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
  test("a merge and a passed pipeline are good, a failed pipeline is an error, and a closed one has no tone", () => {
    expect(mergeRequestStateLabel("merged")).toEqual({ tone: "ok", label: "merged" });
    expect(mergeRequestStateLabel("closed")).toEqual({ label: "closed" });
    expect(pipelineLabel("passed")).toEqual({ tone: "ok", label: "pipeline passed" });
    expect(pipelineLabel("failed")).toEqual({ tone: "error", label: "pipeline failed" });
    expect(pipelineLabel("manual")).toEqual({ tone: "warning", label: "pipeline waits for a manual job" });
  });
});

describe("a failed pipeline in the task panel (ADR-197)", () => {
  const mergeRequest = (state: "open" | "merged", pipeline: "failed" | "running") => ({
    number: 12,
    title: "Add a discount",
    url: "https://gitlab.example.com/shop/-/merge_requests/12",
    state,
    pipeline: { state: pipeline, url: "https://gitlab.example.com/shop/-/pipelines/41", commit: "a".repeat(40), failedJobs: [] },
  });

  test("Fix is offered only for a failed pipeline of an open merge request", () => {
    expect(canFixPipeline(mergeRequest("open", "failed"))).toBe(true);
    expect(canFixPipeline(mergeRequest("open", "running"))).toBe(false);
    expect(canFixPipeline(mergeRequest("merged", "failed"))).toBe(false);
  });

  test("a job's log says what it leaves out", () => {
    const job = { name: "unit-tests", url: "https://gitlab.example.com/shop/-/jobs/7", id: "7" };
    expect(jobLogNote({ job, text: "ERROR: Job failed", truncated: false })).toBeNull();
    expect(jobLogNote({ job, text: "ERROR: Job failed", truncated: true })).toBe(
      "The last 150 lines at most: the job's page has the whole log.",
    );
    expect(jobLogNote({ job, text: "", truncated: true })).toBe("The log is too long for Trackwall to read its end: open the job's page.");
  });
});

import { describe, expect, test } from "bun:test";
import type { MergeRequestThread, PipelineFix, ReviewComment, TestFailure } from "@trackwall/protocol";
import { StoredReviews, TaskReviews } from "../src/modules/agents/task-reviews.ts";

const comment: ReviewComment = { path: "src/a.ts", side: "new", line: 3, code: "return 1;", text: "Return 2." };
const fix = (commit: string): PipelineFix => ({
  pipeline: "https://gitlab.example.com/shop/-/pipelines/41",
  commit,
  logs: [
    { job: { name: "unit-tests", url: "https://gitlab.example.com/shop/-/jobs/7", id: "7" }, text: "ERROR: Job failed", truncated: false },
  ],
  otherJobs: ["sonar"],
});

const MR = "https://gitlab.example.com/shop/-/merge_requests/12";
const thread = (id: string, text: string): MergeRequestThread => ({
  id,
  file: "src/cart.ts",
  line: { side: "new", number: 14 },
  url: `${MR}#note_1`,
  notes: [{ author: "reviewer", text, at: "2026-11-16T10:00:00Z" }],
  moreNotes: 0,
});

describe("unread review comments of a task", () => {
  test("reviews add up until the agent reads them, and are read once", () => {
    const reviews = new TaskReviews(() => {});
    expect(reviews.add("t1", [comment])).toBe(1);
    expect(reviews.add("t1", [comment, comment])).toBe(3);
    expect(reviews.add("t2", [comment])).toBe(1);

    expect(reviews.take("t1").comments).toHaveLength(3);
    expect(reviews.take("t1")).toEqual({ comments: [], pipelineFix: null, testFix: null, mergeRequestComments: null });
    expect(reviews.unread("t2")).toBe(1);
  });

  test("a review beyond 60 unread comments is refused and changes nothing", () => {
    const reviews = new TaskReviews(() => {});
    reviews.add(
      "t1",
      Array.from({ length: 60 }, () => comment),
    );

    expect(() => reviews.add("t1", [comment])).toThrow("the agent has not read 60 comments yet; at most 60 can wait for it");
    expect(reviews.unread("t1")).toBe(60);
  });

  test("the next daemon gets back the unread comments of the tasks that are still there (ADR-115)", () => {
    const [kept, ended] = ["6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f", "0b6c9e1a-7d2f-4c3b-8e5a-9f1d2c3b4a5e"];
    const changes: string[] = [];
    const before = new TaskReviews(() => changes.push("changed"));
    before.add(kept, [comment]);
    before.add(ended, [comment, comment]);
    expect(before.take("unknown")).toEqual({ comments: [], pipelineFix: null, testFix: null, mergeRequestComments: null });
    expect(changes).toHaveLength(2);

    const after = new TaskReviews(() => {});
    after.restore(before.stored(), (task) => task === kept);

    expect(after.take(kept)).toEqual({ comments: [comment], pipelineFix: null, testFix: null, mergeRequestComments: null });
    expect(after.unread(ended)).toBe(0);
  });

  test("a pipeline fix waits with the comments, a newer one replaces it, and both are read at once (ADR-197)", () => {
    const reviews = new TaskReviews(() => {});
    reviews.add("t1", [comment]);
    reviews.fixPipeline("t1", fix("a".repeat(40)));
    reviews.fixPipeline("t1", fix("b".repeat(40)));

    expect(reviews.pipelineFixUnread("t1")).toBe(true);
    expect(reviews.take("t1")).toEqual({
      comments: [comment],
      pipelineFix: fix("b".repeat(40)),
      testFix: null,
      mergeRequestComments: null,
    });
    expect(reviews.pipelineFixUnread("t1")).toBe(false);
  });

  test("an unread pipeline fix outlives a daemon restart, and a file from before it still loads", () => {
    const task = "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f";
    const before = new TaskReviews(() => {});
    before.fixPipeline(task, fix("a".repeat(40)));

    const after = new TaskReviews(() => {});
    after.restore(StoredReviews.parse(JSON.parse(JSON.stringify(before.stored()))), () => true);
    expect(after.take(task)).toEqual({ comments: [], pipelineFix: fix("a".repeat(40)), testFix: null, mergeRequestComments: null });

    const old = new TaskReviews(() => {});
    old.restore(StoredReviews.parse([{ task, comments: [comment] }]), () => true);
    expect(old.take(task)).toEqual({ comments: [comment], pipelineFix: null, testFix: null, mergeRequestComments: null });
  });

  test("a test fix waits with the comments, a newer one replaces it, and it outlives a daemon restart (ADR-302)", () => {
    const task = "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f";
    const failure: TestFailure = {
      report: "target/surefire-reports/TEST-shop.CartTest.xml",
      suite: "shop.CartTest",
      className: "shop.CartTest",
      name: "sums",
      kind: "failure",
      type: "org.opentest4j.AssertionFailedError",
      message: "expected: <3> but was: <4>",
      lines: ["\tat shop.CartTest.sums(CartTest.java:12)"],
      omittedLines: 0,
      timeSeconds: 0.1,
    };
    const before = new TaskReviews(() => {});
    before.add(task, [comment]);
    before.fixTests(task, { runId: "run-1", outdated: false, failures: [failure], otherFailures: 2 });
    before.fixTests(task, { runId: "run-2", outdated: true, failures: [failure], otherFailures: 0 });
    expect(before.testFixUnread(task)).toBe(true);

    const after = new TaskReviews(() => {});
    after.restore(StoredReviews.parse(JSON.parse(JSON.stringify(before.stored()))), () => true);
    expect(after.take(task)).toEqual({
      comments: [comment],
      pipelineFix: null,
      testFix: { runId: "run-2", outdated: true, failures: [failure], otherFailures: 0 },
      mergeRequestComments: null,
    });
    expect(after.testFixUnread(task)).toBe(false);
  });

  test("merge request threads add up by thread until the agent reads them, a thread sent again replaces its copy (ADR-256)", () => {
    const reviews = new TaskReviews(() => {});
    reviews.addThreads("t1", { mergeRequest: MR, threads: [thread("a1", "Use a constant."), thread("b2", "Add a test.")] });
    reviews.addThreads("t1", { mergeRequest: MR, threads: [thread("a1", "Use a constant, please.")] });

    expect(reviews.threadsUnread("t1")).toBe(true);
    expect(reviews.take("t1")).toEqual({
      comments: [],
      pipelineFix: null,
      testFix: null,
      mergeRequestComments: { mergeRequest: MR, threads: [thread("b2", "Add a test."), thread("a1", "Use a constant, please.")] },
    });
    expect(reviews.threadsUnread("t1")).toBe(false);
  });

  test("threads of another merge request start afresh, and more than 15 unread are refused", () => {
    const reviews = new TaskReviews(() => {});
    reviews.addThreads("t1", { mergeRequest: MR, threads: [thread("a1", "Old.")] });
    const next = "https://gitlab.example.com/shop/-/merge_requests/13";
    const fifteen = Array.from({ length: 15 }, (_, i) => thread(`n${i}`, "New."));
    reviews.addThreads("t1", { mergeRequest: next, threads: fifteen });

    expect(() => reviews.addThreads("t1", { mergeRequest: next, threads: [thread("x", "One more.")] })).toThrow(
      "the agent has not read 15 merge request threads yet; at most 15 can wait for it",
    );
    expect(reviews.take("t1").mergeRequestComments).toEqual({ mergeRequest: next, threads: fifteen });
  });

  test("unread merge request threads outlive a daemon restart", () => {
    const task = "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f";
    const before = new TaskReviews(() => {});
    before.addThreads(task, { mergeRequest: MR, threads: [thread("a1", "Use a constant.")] });

    const after = new TaskReviews(() => {});
    after.restore(StoredReviews.parse(JSON.parse(JSON.stringify(before.stored()))), () => true);
    expect(after.take(task).mergeRequestComments).toEqual({ mergeRequest: MR, threads: [thread("a1", "Use a constant.")] });
  });
});

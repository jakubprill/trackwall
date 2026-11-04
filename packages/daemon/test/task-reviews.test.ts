import { describe, expect, test } from "bun:test";
import type { PipelineFix, ReviewComment } from "@trackwall/protocol";
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

describe("unread review comments of a task", () => {
  test("reviews add up until the agent reads them, and are read once", () => {
    const reviews = new TaskReviews(() => {});
    expect(reviews.add("t1", [comment])).toBe(1);
    expect(reviews.add("t1", [comment, comment])).toBe(3);
    expect(reviews.add("t2", [comment])).toBe(1);

    expect(reviews.take("t1").comments).toHaveLength(3);
    expect(reviews.take("t1")).toEqual({ comments: [], pipelineFix: null });
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
    expect(before.take("unknown")).toEqual({ comments: [], pipelineFix: null });
    expect(changes).toHaveLength(2);

    const after = new TaskReviews(() => {});
    after.restore(before.stored(), (task) => task === kept);

    expect(after.take(kept)).toEqual({ comments: [comment], pipelineFix: null });
    expect(after.unread(ended)).toBe(0);
  });

  test("a pipeline fix waits with the comments, a newer one replaces it, and both are read at once (ADR-197)", () => {
    const reviews = new TaskReviews(() => {});
    reviews.add("t1", [comment]);
    reviews.fixPipeline("t1", fix("a".repeat(40)));
    reviews.fixPipeline("t1", fix("b".repeat(40)));

    expect(reviews.pipelineFixUnread("t1")).toBe(true);
    expect(reviews.take("t1")).toEqual({ comments: [comment], pipelineFix: fix("b".repeat(40)) });
    expect(reviews.pipelineFixUnread("t1")).toBe(false);
  });

  test("an unread pipeline fix outlives a daemon restart, and a file from before it still loads", () => {
    const task = "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f";
    const before = new TaskReviews(() => {});
    before.fixPipeline(task, fix("a".repeat(40)));

    const after = new TaskReviews(() => {});
    after.restore(StoredReviews.parse(JSON.parse(JSON.stringify(before.stored()))), () => true);
    expect(after.take(task)).toEqual({ comments: [], pipelineFix: fix("a".repeat(40)) });

    const old = new TaskReviews(() => {});
    old.restore(StoredReviews.parse([{ task, comments: [comment] }]), () => true);
    expect(old.take(task)).toEqual({ comments: [comment], pipelineFix: null });
  });
});

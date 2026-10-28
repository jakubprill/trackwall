import { describe, expect, test } from "bun:test";
import type { ReviewComment } from "@trackwall/protocol";
import { TaskReviews } from "../src/modules/agents/task-reviews.ts";

const comment: ReviewComment = { path: "src/a.ts", side: "new", line: 3, code: "return 1;", text: "Return 2." };

describe("unread review comments of a task", () => {
  test("reviews add up until the agent reads them, and are read once", () => {
    const reviews = new TaskReviews(() => {});
    expect(reviews.add("t1", [comment])).toBe(1);
    expect(reviews.add("t1", [comment, comment])).toBe(3);
    expect(reviews.add("t2", [comment])).toBe(1);

    expect(reviews.take("t1")).toHaveLength(3);
    expect(reviews.take("t1")).toEqual([]);
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
    expect(before.take("unknown")).toEqual([]);
    expect(changes).toHaveLength(2);

    const after = new TaskReviews(() => {});
    after.restore(before.stored(), (task) => task === kept);

    expect(after.take(kept)).toEqual([comment]);
    expect(after.unread(ended)).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { ReviewComment } from "@trackwall/protocol";
import { TaskReviews } from "../src/modules/agents/task-reviews.ts";

const comment: ReviewComment = { path: "src/a.ts", side: "new", line: 3, code: "return 1;", text: "Return 2." };

describe("unread review comments of a task", () => {
  test("reviews add up until the agent reads them, and are read once", () => {
    const reviews = new TaskReviews();
    expect(reviews.add("t1", [comment])).toBe(1);
    expect(reviews.add("t1", [comment, comment])).toBe(3);
    expect(reviews.add("t2", [comment])).toBe(1);

    expect(reviews.take("t1")).toHaveLength(3);
    expect(reviews.take("t1")).toEqual([]);
    expect(reviews.unread("t2")).toBe(1);
  });

  test("a review beyond 60 unread comments is refused and changes nothing", () => {
    const reviews = new TaskReviews();
    reviews.add(
      "t1",
      Array.from({ length: 60 }, () => comment),
    );

    expect(() => reviews.add("t1", [comment])).toThrow("the agent has not read 60 comments yet; at most 60 can wait for it");
    expect(reviews.unread("t1")).toBe(60);
  });
});

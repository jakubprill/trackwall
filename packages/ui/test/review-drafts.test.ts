import { describe, expect, test } from "bun:test";
import { anchorKey, deliveryMessage, lineComment } from "../src/lib/review-drafts.ts";

describe("review comments on a task's changes", () => {
  test("a comment keeps the line's code without the diff marker, and the text without surrounding blanks", () => {
    expect(lineComment({ path: "src/a.ts", side: "old", line: 7 }, "-  return null;", "  Why did this go?\n")).toEqual({
      path: "src/a.ts",
      side: "old",
      line: 7,
      code: "  return null;",
      text: "Why did this go?",
    });
  });

  test("a very long line is cut to the 500 characters the daemon keeps", () => {
    expect(lineComment({ path: "a.min.js", side: "new", line: 1 }, `+${"x".repeat(600)}`, "minified?").code).toHaveLength(500);
  });

  test("the same line number on the old and the new side are different places", () => {
    expect(anchorKey({ path: "a.ts", side: "old", line: 3 })).not.toBe(anchorKey({ path: "a.ts", side: "new", line: 3 }));
  });

  test("the user learns when the agent gets the review", () => {
    expect(deliveryMessage("typed")).toBe("Sent: the agent is reading your review.");
    expect(deliveryMessage("queued")).toBe("Sent: the agent gets your review once it waits for input again.");
    expect(deliveryMessage("on_resume")).toBe("Saved: the agent gets your review when you resume the task.");
  });
});

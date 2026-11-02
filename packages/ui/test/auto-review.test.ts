import { describe, expect, test } from "bun:test";
import type { AutoReview, AutoReviewFinding } from "@trackwall/protocol";
import { autoReviewLabel, findingComment, inDrafts } from "../src/lib/auto-review.ts";

const PATCH = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -10,3 +10,4 @@ export class Cart {",
  "   total() {",
  "-    return this.sum;",
  "+    const sum = this.items.reduce((a, b) => a + b, 0);",
  "+    return sum;",
  "   }",
  "",
].join("\n");

const finding = (over: Partial<AutoReviewFinding>): AutoReviewFinding => ({
  title: "Discount ignored",
  severity: "high",
  path: "src/cart.ts",
  line: 11,
  text: "The sum leaves out the discount.",
  ...over,
});

describe("a finding of the automatic review as a review comment (ADR-182)", () => {
  test("a finding on an added line becomes a comment on that line, with the line's code and the title over the text", () => {
    expect(findingComment(finding({}), PATCH)).toEqual({
      path: "src/cart.ts",
      side: "new",
      line: 11,
      code: "    const sum = this.items.reduce((a, b) => a + b, 0);",
      text: "Discount ignored\n\nThe sum leaves out the discount.",
    });
  });

  test("an unchanged line the diff shows takes a comment too", () => {
    expect(findingComment(finding({ line: 10 }), PATCH)).toMatchObject({ line: 10, code: "  total() {" });
  });

  test("a line the diff does not show, another file or no line gives no comment", () => {
    expect(findingComment(finding({ line: 40 }), PATCH)).toBeNull();
    expect(findingComment(finding({ path: "src/tax.ts" }), PATCH)).toBeNull();
    expect(findingComment(finding({ line: null }), PATCH)).toBeNull();
    expect(findingComment(finding({ path: null, line: null }), PATCH)).toBeNull();
  });

  test("a long finding is cut to what a review comment holds", () => {
    const comment = findingComment(finding({ text: "x".repeat(2000) }), PATCH);

    expect(comment?.text).toHaveLength(2000);
    expect(comment?.text.endsWith("…")).toBe(true);
  });

  test("a finding already added is in the drafts, one on another line is not", () => {
    const comment = findingComment(finding({}), PATCH);
    if (comment === null) throw new Error("no comment");

    expect(inDrafts(comment, [{ id: 0, comment }])).toBe(true);
    expect(inDrafts(comment, [{ id: 0, comment: { ...comment, line: 12 } }])).toBe(false);
  });
});

describe("the state of an automatic review", () => {
  const review = (over: Partial<AutoReview>): AutoReview => ({
    task: "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f",
    repo: "shop",
    state: "done",
    trigger: "user",
    startedAt: "2026-11-02T10:00:00Z",
    finishedAt: "2026-11-02T10:02:00Z",
    diffHash: "0".repeat(64),
    diffTruncated: false,
    findings: [],
    text: "",
    message: null,
    ...over,
  });

  test("says how many findings a finished review has, and that a running one reviews", () => {
    expect(autoReviewLabel(review({}))).toEqual({ tone: "ok", label: "no findings" });
    expect(autoReviewLabel(review({ findings: [finding({}), finding({})] }))).toEqual({ tone: "warning", label: "2 findings" });
    expect(autoReviewLabel(review({ state: "running" }))).toEqual({ tone: "warning", label: "reviewing" });
    expect(autoReviewLabel(review({ state: "failed" }))).toEqual({ tone: "error", label: "failed" });
  });
});

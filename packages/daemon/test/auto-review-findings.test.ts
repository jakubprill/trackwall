import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { reviewFindings } from "../src/modules/agents/auto-review-findings.ts";

const WORKTREE = join("/", "work", "shop-task");

describe("findings read from the reviewer's answer (ADR-182)", () => {
  test("each issue in the review agent's format is a finding, with its path relative to the worktree", () => {
    const answer = [
      "I reviewed the changes.",
      "",
      "## Issue: Total ignores the discount",
      `**File:** ${join(WORKTREE, "src", "cart.ts")}:12`,
      "**Severity:** High",
      "**Problem:** `total()` adds the items",
      "but never subtracts the discount.",
      "**Evidence:** The discount test expects 90.",
      "**Suggested fix:** Subtract `discount` before returning.",
      "",
      "### Issue 2: Tax rounds down",
      "**File:** `src/tax.ts:4-6`",
      "**Severity:** Medium",
      "**Problem:** `Math.floor` drops cents.",
      "",
      "That is all.",
    ].join("\n");

    expect(reviewFindings(answer, WORKTREE)).toEqual([
      {
        title: "Total ignores the discount",
        severity: "high",
        path: "src/cart.ts",
        line: 12,
        text: "`total()` adds the items\nbut never subtracts the discount.\n\nSuggested fix: Subtract `discount` before returning.",
      },
      { title: "Tax rounds down", severity: "medium", path: "src/tax.ts", line: 4, text: "`Math.floor` drops cents." },
    ]);
  });

  test("a path outside the worktree or with .. keeps no path and no line", () => {
    const issue = (file: string) => `## Issue: Leak\n**File:** ${file}\n**Problem:** It leaks.`;

    expect(reviewFindings(issue(`${join("/", "etc", "passwd")}:1`), WORKTREE)[0]).toMatchObject({ path: null, line: null });
    expect(reviewFindings(issue("../other/a.ts:3"), WORKTREE)[0]).toMatchObject({ path: null, line: null });
    expect(reviewFindings(issue("src/a.ts"), WORKTREE)[0]).toMatchObject({ path: "src/a.ts", line: null });
  });

  test("an answer in another shape, or an issue without a problem, gives no findings", () => {
    expect(reviewFindings("No significant issues found in the reviewed changes.", WORKTREE)).toEqual([]);
    expect(reviewFindings("## Issue: Something\n**File:** src/a.ts:1", WORKTREE)).toEqual([]);
  });

  test("invisible characters are dropped, an unknown severity is none, and text is cut to a review comment", () => {
    const answer = `## Issue: Hidden​ text\n**Severity:** Severe\n**Problem:** ${"x".repeat(3000)}`;

    const [finding] = reviewFindings(answer, WORKTREE);

    expect(finding?.title).toBe("Hidden text");
    expect(finding?.severity).toBeNull();
    expect(finding?.text).toHaveLength(2000);
    expect(finding?.text.endsWith("…")).toBe(true);
  });

  test("at most 20 findings are kept", () => {
    const answer = Array.from({ length: 25 }, (_, i) => `## Issue: Number ${i}\n**Problem:** Wrong.`).join("\n\n");

    expect(reviewFindings(answer, WORKTREE)).toHaveLength(20);
  });
});

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

    expect(reviewFindings(answer, [WORKTREE])).toEqual([
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

  test("a code block in a field keeps its blank lines, and the field ends at the first blank line after it", () => {
    const answer = [
      "## Issue: Tax rounds down",
      "**Problem:** `Math.floor` drops cents.",
      "**Suggested fix:** Round instead:",
      "```ts",
      "const cents = Math.round(amount * 100);",
      "",
      "return cents / 100;",
      "```",
      "",
      "The rest looks fine.",
    ].join("\n");

    expect(reviewFindings(answer, [WORKTREE])[0]?.text).toBe(
      "`Math.floor` drops cents.\n\nSuggested fix: Round instead:\n```ts\nconst cents = Math.round(amount * 100);\n\nreturn cents / 100;\n```",
    );
  });

  test("a path in the worktree as the reviewer sees it with links resolved is relative to the worktree too", () => {
    const resolved = join("/", "private", "work", "shop-task");
    const answer = `## Issue: Leak\n**File:** ${join(resolved, "src", "a.ts")}:7\n**Problem:** It leaks.`;

    expect(reviewFindings(answer, [WORKTREE])[0]).toMatchObject({ path: null, line: null });
    expect(reviewFindings(answer, [WORKTREE, resolved])[0]).toMatchObject({ path: "src/a.ts", line: 7 });
  });

  test("a path outside the worktree or with .. keeps no path and no line", () => {
    const issue = (file: string) => `## Issue: Leak\n**File:** ${file}\n**Problem:** It leaks.`;

    expect(reviewFindings(issue(`${join("/", "etc", "passwd")}:1`), [WORKTREE])[0]).toMatchObject({ path: null, line: null });
    expect(reviewFindings(issue("../other/a.ts:3"), [WORKTREE])[0]).toMatchObject({ path: null, line: null });
    expect(reviewFindings(issue("src/a.ts"), [WORKTREE])[0]).toMatchObject({ path: "src/a.ts", line: null });
  });

  test("an answer in another shape, or an issue without a problem, gives no findings", () => {
    expect(reviewFindings("No significant issues found in the reviewed changes.", [WORKTREE])).toEqual([]);
    expect(reviewFindings("## Issue: Something\n**File:** src/a.ts:1", [WORKTREE])).toEqual([]);
  });

  test("invisible characters are dropped, an unknown severity is none, and text is cut to a review comment", () => {
    const answer = `## Issue: Hidden​ text\n**Severity:** Severe\n**Problem:** ${"x".repeat(3000)}`;

    const [finding] = reviewFindings(answer, [WORKTREE]);

    expect(finding?.title).toBe("Hidden text");
    expect(finding?.severity).toBeNull();
    expect(finding?.text).toHaveLength(2000);
    expect(finding?.text.endsWith("…")).toBe(true);
  });

  test("at most 20 findings are kept", () => {
    const answer = Array.from({ length: 25 }, (_, i) => `## Issue: Number ${i}\n**Problem:** Wrong.`).join("\n\n");

    expect(reviewFindings(answer, [WORKTREE])).toHaveLength(20);
  });
});

describe("findings read from a check against the repo's rules (ADR-230)", () => {
  test("the rule a violation breaks goes into the finding's text between the problem and the fix", () => {
    const answer = [
      "## Issue: Shell script added to the repo",
      "**File:** scripts/release.sh:1",
      "**Severity:** Medium",
      '**Rule:** AGENTS.md: "Scripts in the repo are in TypeScript, not bash or PowerShell"',
      "**Problem:** The change adds a bash script.",
      "**Suggested fix:** Write it as `scripts/release.ts`.",
    ].join("\n");

    expect(reviewFindings(answer, [WORKTREE])).toEqual([
      {
        title: "Shell script added to the repo",
        severity: "medium",
        path: "scripts/release.sh",
        line: 1,
        text: 'The change adds a bash script.\n\nRule: AGENTS.md: "Scripts in the repo are in TypeScript, not bash or PowerShell"\n\nSuggested fix: Write it as `scripts/release.ts`.',
      },
    ]);
  });

  test("the answer of a check that found nothing gives no findings", () => {
    expect(reviewFindings("No rule violations found.", [WORKTREE])).toEqual([]);
  });
});

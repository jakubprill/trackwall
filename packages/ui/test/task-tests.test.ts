import { describe, expect, test } from "bun:test";
import type { TaskTestCase } from "@trackwall/protocol";
import { filterCount, groupCountLabel, startsOpen, testGroups, testKeys, testTime } from "../src/lib/task-tests";

function testCase(className: string, name: string, kind: TaskTestCase["kind"]): TaskTestCase {
  return { report: `TEST-${className}.xml`, suite: className, className, name, kind, timeSeconds: 0.04, failure: null };
}

// In the daemon's order: failed, then skipped, then passed.
const CASES = [
  testCase("shop.DiscountTest", "appliesPercent", "failure"),
  testCase("shop.CartControllerIT", "returnsTotal", "error"),
  testCase("shop.DiscountTest", "inYen", "skipped"),
  testCase("shop.DiscountTest", "appliesFixed", "passed"),
  testCase("shop.CartControllerIT", "addsItem", "passed"),
  testCase("shop.PriceTest", "rounds", "passed"),
];
const TOTALS = { tests: 6, failures: 1, errors: 1, skipped: 1, timeSeconds: 0.24 };

describe("the Tests tab's list (ADR-304)", () => {
  test("by default lists only the failed tests, by class, classes without a failure left out", () => {
    const groups = testGroups(CASES, "failed", "");

    expect(groups.map((g) => [g.name, g.cases.map((c) => c.name), groupCountLabel(g)])).toEqual([
      ["shop.DiscountTest", ["appliesPercent"], "1 of 3"],
      ["shop.CartControllerIT", ["returnsTotal"], "1 of 2"],
    ]);
  });

  test("All lists every test, classes with a failure first and unfolded, the others folded", () => {
    const groups = testGroups(CASES, "all", "");

    expect(groups.map((g) => [g.name, g.cases.length, groupCountLabel(g), startsOpen(g, "all")])).toEqual([
      ["shop.DiscountTest", 3, "1 of 3", true],
      ["shop.CartControllerIT", 2, "1 of 2", true],
      ["shop.PriceTest", 1, "1 passed", false],
    ]);
  });

  test("a name narrows the list to tests whose own or class name holds it, in any case", () => {
    expect(testGroups(CASES, "all", "DISCOUNT").map((g) => [g.name, g.cases.map((c) => c.name)])).toEqual([
      ["shop.DiscountTest", ["appliesPercent", "inYen", "appliesFixed"]],
    ]);
    expect(testGroups(CASES, "all", "total").map((g) => g.cases.map((c) => c.name))).toEqual([["returnsTotal"]]);
    expect(testGroups(CASES, "failed", "rounds")).toEqual([]);
  });

  test("Skipped lists the skipped tests, and each chip counts every test of the reports", () => {
    expect(testGroups(CASES, "skipped", "").map((g) => g.cases.map((c) => c.name))).toEqual([["inYen"]]);
    expect([
      filterCount({ totals: TOTALS }, "failed"),
      filterCount({ totals: TOTALS }, "skipped"),
      filterCount({ totals: TOTALS }, "all"),
    ]).toEqual([2, 1, 6]);
  });

  test("a test repeated in a report (a retry) gets a key of its own", () => {
    const first = testCase("shop.FlakyTest", "retries", "failure");
    const again = testCase("shop.FlakyTest", "retries", "failure");

    const keys = testKeys([first, again]);

    expect(keys.get(first)).not.toBe(keys.get(again));
  });

  test("a test's time has two decimals, and none when the report has none", () => {
    expect(testTime(0.041)).toBe("0.04 s");
    expect(testTime(null)).toBe("");
  });
});

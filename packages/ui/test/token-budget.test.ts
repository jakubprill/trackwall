import { describe, expect, test } from "bun:test";
import { parseTokenBudget, tokenBudgetLabel, tokenBudgetNote } from "../src/lib/token-budget.ts";

describe("a task's token budget in the UI (ADR-237)", () => {
  test("the amount typed in Settings takes plain numbers, separators and the k and M units", () => {
    expect(parseTokenBudget("2000000")).toEqual({ budget: 2_000_000 });
    expect(parseTokenBudget("2 000 000")).toEqual({ budget: 2_000_000 });
    expect(parseTokenBudget("2,000,000")).toEqual({ budget: 2_000_000 });
    expect(parseTokenBudget("2M")).toEqual({ budget: 2_000_000 });
    expect(parseTokenBudget("1.5m")).toEqual({ budget: 1_500_000 });
    expect(parseTokenBudget("500k")).toEqual({ budget: 500_000 });
  });

  test("anything else is refused with what to type", () => {
    expect(parseTokenBudget("lots")).toEqual({ problem: "Type a number of tokens, such as 2000000, 2M or 500k." });
    expect(parseTokenBudget("2G")).toEqual({ problem: "Type a number of tokens, such as 2000000, 2M or 500k." });
    expect(parseTokenBudget("0")).toEqual({ problem: "The budget must be a whole number of tokens above zero." });
  });

  test("the mark next to the usage shows what this start used of the budget", () => {
    expect(tokenBudgetLabel({ budget: 2_000_000, used: 1_234_000, reached: false }).label).toBe("1.2M of 2M tokens");
  });

  test("the strip shows only once the daemon stopped the session at its budget", () => {
    expect(tokenBudgetNote({ tokenBudget: null })).toBeNull();
    expect(tokenBudgetNote({ tokenBudget: { budget: 2_000_000, used: 1_900_000, reached: false } })).toBeNull();
    expect(tokenBudgetNote({ tokenBudget: { budget: 2_000_000, used: 2_050_000, reached: true } })).toEqual({
      title: "Stopped at its token budget: 2.1M of 2M tokens",
      detail: "Resume goes on with the same conversation and gives the task another 2M tokens. Settings › Agents changes the budget.",
    });
  });
});

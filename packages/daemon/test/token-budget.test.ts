import { describe, expect, test } from "bun:test";
import { TokenBudget } from "../src/modules/agents/token-budget.ts";

describe("a task session's token budget (ADR-237)", () => {
  test("below the budget nothing happens, at it the session is stopped once, however often it is checked after", () => {
    const stops: string[] = [];
    const budget = new TokenBudget(1000, () => stops.push("stop"));

    budget.check(999);
    expect(stops).toEqual([]);
    expect(budget.view(999)).toEqual({ budget: 1000, used: 999, reached: false });

    budget.check(1000);
    budget.check(1500);
    expect(stops).toEqual(["stop"]);
    expect(budget.view(1500)).toEqual({ budget: 1000, used: 1500, reached: true });
  });
});

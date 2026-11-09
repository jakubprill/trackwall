import { describe, expect, test } from "bun:test";
import { TokenBudget } from "../src/modules/agents/token-budget.ts";

describe("a task session's token budget (ADR-237)", () => {
  test("below the budget nothing happens, at it the session is stopped once, however often it is checked after", async () => {
    let used = 999;
    const stops: number[] = [];
    const budget = new TokenBudget(
      1000,
      () => used,
      async () => {
        stops.push(used);
      },
    );

    budget.check();
    expect(stops).toEqual([]);
    expect(budget.view()).toEqual({ budget: 1000, used: 999, reached: false });

    used = 1000;
    budget.check();
    used = 1500;
    await Promise.resolve();
    budget.check();
    expect(stops).toEqual([1000]);
    expect(budget.view()).toEqual({ budget: 1000, used: 1500, reached: true });
  });

  test("a stop that fails is tried again at the next check", async () => {
    let attempts = 0;
    const budget = new TokenBudget(
      10,
      () => 20,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("the process group did not stop");
      },
    );

    budget.check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    budget.check();

    expect(attempts).toBe(2);
    expect(budget.view().reached).toBe(true);
  });
});

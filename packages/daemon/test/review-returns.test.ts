import { describe, expect, test } from "bun:test";
import { ReviewReturns } from "../src/modules/agents/review-returns.ts";

describe("review returns: work given back to a task in review", () => {
  test("the next turn that changes nothing puts the task back in review, once", () => {
    const returns = new ReviewReturns();
    returns.gaveWork("t1");
    returns.turnStarted("t1");
    expect(returns.turnOver("t1", false)).toBe(true);
    returns.turnStarted("t1");
    expect(returns.turnOver("t1", false)).toBe(false);
  });

  test("a turn that changed the worktree keeps the task at work", () => {
    const returns = new ReviewReturns();
    returns.gaveWork("t1");
    returns.turnStarted("t1");
    expect(returns.turnOver("t1", true)).toBe(false);
  });

  test("the turn already running when the work came does not count, the one after it does", () => {
    const returns = new ReviewReturns();
    returns.turnStarted("t1");
    returns.gaveWork("t1");
    expect(returns.turnOver("t1", false)).toBe(false);
    returns.turnStarted("t1");
    expect(returns.turnOver("t1", false)).toBe(true);
  });

  test("a report or the end of the task forgets the work given", () => {
    const returns = new ReviewReturns();
    returns.gaveWork("t1");
    returns.forget("t1");
    returns.turnStarted("t1");
    expect(returns.turnOver("t1", false)).toBe(false);
  });
});

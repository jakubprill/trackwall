import { describe, expect, test } from "bun:test";
import { Slots } from "../src/modules/vcs/slots.ts";

describe("Slots", () => {
  test("runs at most the limit of jobs at once across separate callers, the rest in arrival order", async () => {
    const slots = new Slots(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const job = (n: number) => async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      running--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => slots.run(job(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
  });

  test("a failed job frees its slot for the next one", async () => {
    const slots = new Slots(1);
    const failed = slots.run(() => Promise.reject(new Error("git crashed")));
    const next = slots.run(() => Promise.resolve("next"));
    await expect(failed).rejects.toThrow("git crashed");
    expect(await next).toBe("next");
  });

  test("a limit below one is a programming error", () => {
    expect(() => new Slots(0)).toThrow("at least 1");
  });
});

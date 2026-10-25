import { describe, expect, test } from "bun:test";
import { singleFlight } from "../src/lib/single-flight.ts";

describe("one call at a time", () => {
  test("two reads at once get one answer, and the next one after it starts again", async () => {
    let calls = 0;
    const read = singleFlight(async () => {
      calls += 1;
      return calls;
    });

    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    expect(await read()).toBe(2);
  });

  test("after an error the next read starts again", async () => {
    let calls = 0;
    const read = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("no connection");
      return calls;
    });

    await expect(read()).rejects.toThrow("no connection");
    expect(await read()).toBe(2);
  });
});

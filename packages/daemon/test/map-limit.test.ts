import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/modules/workspace/map-limit.ts";

describe("mapLimit", () => {
  test("wyniki są w kolejności wejścia, a naraz działa najwyżej limit wywołań", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(ms);
      running--;
      return ms * 2;
    });

    expect(results).toEqual([60, 20, 40, 10, 30]);
    expect(peak).toBe(2);
  });

  test("pusta lista daje pusty wynik", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

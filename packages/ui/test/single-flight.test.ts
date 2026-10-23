import { describe, expect, test } from "bun:test";
import { singleFlight } from "../src/lib/single-flight.ts";

describe("jedno wywołanie naraz", () => {
  test("dwa odczyty naraz dostają jedną odpowiedź, a następny po niej idzie od nowa", async () => {
    let calls = 0;
    const read = singleFlight(async () => {
      calls += 1;
      return calls;
    });

    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    expect(await read()).toBe(2);
  });

  test("po błędzie następny odczyt idzie od nowa", async () => {
    let calls = 0;
    const read = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("brak połączenia");
      return calls;
    });

    await expect(read()).rejects.toThrow("brak połączenia");
    expect(await read()).toBe(2);
  });
});

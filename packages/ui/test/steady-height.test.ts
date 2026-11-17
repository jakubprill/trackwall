import { describe, expect, test } from "bun:test";
import { readSteadyHeight, saveSteadyHeight } from "../src/lib/steady-height.ts";

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    }),
  };
}

const refuses = (): never => {
  throw new Error("storage is not available");
};

describe("the height a loading part holds (ADR-264)", () => {
  test("a part has no height to hold until it showed its data once", () => {
    expect(readSteadyHeight(memory().storage, "doctor")).toBeNull();
  });

  test("the height saved for a part is read back for that part only, rounded to whole pixels", () => {
    const store = memory();
    saveSteadyHeight(store.storage, "doctor", 812.4);
    expect(store.items.get("trackwall.height.doctor")).toBe("812");
    expect(readSteadyHeight(store.storage, "doctor")).toBe(812);
    expect(readSteadyHeight(store.storage, "usage-week")).toBeNull();
  });

  test("a stored value that is not a plausible height reads as none", () => {
    for (const stored of ["", "tall", "-40", "0", "12.5", "99999"]) {
      expect(readSteadyHeight(memory({ "trackwall.height.doctor": stored }).storage, "doctor")).toBeNull();
    }
  });

  test("storage that refuses access gives no height and loses the save without an error", () => {
    expect(readSteadyHeight(refuses, "doctor")).toBeNull();
    expect(() => saveSteadyHeight(refuses, "doctor", 300)).not.toThrow();
  });
});

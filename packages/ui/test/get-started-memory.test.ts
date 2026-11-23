import { describe, expect, test } from "bun:test";
import { getStartedEntry } from "../src/lib/get-started.ts";
import { readOpenSteps, saveOpenSteps } from "../src/lib/get-started-memory.ts";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
}

describe("the remembered open steps of Get started", () => {
  test("a saved count is read back, zero included", () => {
    const store = storage();
    saveOpenSteps(store, 2);
    expect(readOpenSteps(store)).toBe(2);
    saveOpenSteps(store, 0);
    expect(readOpenSteps(store)).toBe(0);
  });

  test("nothing saved, or a value that is no count, reads as unknown", () => {
    expect(readOpenSteps(storage())).toBeNull();
    expect(readOpenSteps(storage({ "trackwall.get-started.open": "many" }))).toBeNull();
    expect(readOpenSteps(storage({ "trackwall.get-started.open": "-1" }))).toBeNull();
    expect(readOpenSteps(storage({ "trackwall.get-started.open": "1.5" }))).toBeNull();
  });

  test("storage that refuses access reads as unknown and a failed write is forgotten", () => {
    const refusing = () => {
      throw new Error("denied");
    };
    expect(readOpenSteps(refusing)).toBeNull();
    expect(() => saveOpenSteps(refusing, 1)).not.toThrow();
  });
});

describe("the entry of Get started in the list of Settings categories", () => {
  test("says how many steps are to do, that all is set, or asks to check before the doctor ever ran", () => {
    expect(getStartedEntry(null)).toEqual({ text: "Check your setup", state: "unknown" });
    expect(getStartedEntry(0)).toEqual({ text: "All set", state: "done" });
    expect(getStartedEntry(1)).toEqual({ text: "1 step to do", state: "to-do" });
    expect(getStartedEntry(3)).toEqual({ text: "3 steps to do", state: "to-do" });
  });
});

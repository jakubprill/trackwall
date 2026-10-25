import { describe, expect, test } from "bun:test";
import { RefreshGate } from "../src/lib/refresh-gate.ts";

describe("refreshing data on a new key", () => {
  test("with nothing on its way and the window visible, a new key fetches at once", () => {
    const gate = new RefreshGate("1");
    gate.sent("1");
    gate.answered(false);
    expect(gate.keyChanged("2", false)).toBe(true);
  });

  test("keys that change during a request make one fetch after the response", () => {
    const gate = new RefreshGate("1");
    gate.sent("1");
    expect([gate.keyChanged("2", false), gate.keyChanged("3", false)]).toEqual([false, false]);
    expect(gate.answered(false)).toBe(true);
    gate.sent("3");
    expect(gate.answered(false)).toBe(false);
  });

  test("a request already sent with the new key covers it", () => {
    const gate = new RefreshGate("1");
    gate.sent("2");
    expect(gate.keyChanged("2", false)).toBe(false);
    expect(gate.answered(false)).toBe(false);
  });

  test("a hidden window waits until it shows, then fetches once", () => {
    const gate = new RefreshGate("1");
    gate.sent("1");
    gate.answered(true);
    expect(gate.keyChanged("2", true)).toBe(false);
    expect(gate.shown()).toBe(true);
    gate.sent("2");
    gate.answered(false);
    expect(gate.shown()).toBe(false);
  });

  test("a response that comes while the window is hidden leaves the change waiting for the window", () => {
    const gate = new RefreshGate("1");
    gate.sent("1");
    gate.keyChanged("2", false);
    expect(gate.answered(true)).toBe(false);
    expect(gate.shown()).toBe(true);
  });

  test("a key that changes and comes back during a request makes no extra fetch", () => {
    const gate = new RefreshGate("a");
    gate.sent("a");
    gate.keyChanged("b", false);
    gate.keyChanged("a", false);
    expect(gate.answered(false)).toBe(false);
  });
});

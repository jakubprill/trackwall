import { describe, expect, test } from "bun:test";
import { copiesSelection } from "../src/lib/terminal-copy.ts";

const ctrlC = { type: "keydown", key: "c", ctrlKey: true, altKey: false, metaKey: false };

describe("copying from the session terminal", () => {
  test("on Windows Ctrl+C and Ctrl+Shift+C copy the selection, and Ctrl+C without a selection interrupts the session", () => {
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection({ ...ctrlC, key: "C" }, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: false })).toBe(false);
    expect(copiesSelection({ ...ctrlC, type: "keyup" }, { mac: false, hasSelection: true })).toBe(false);
  });

  test("on macOS Ctrl+C stays an interrupt, because Cmd+C copies", () => {
    expect(copiesSelection(ctrlC, { mac: true, hasSelection: true })).toBe(false);
  });
});

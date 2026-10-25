import { describe, expect, test } from "bun:test";
import { copiesSelection, keepsSelection } from "../src/lib/terminal-copy.ts";

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

test("a mouse move over selected text does not reach Copilot CLI, so the selection stays until it is copied", () => {
  expect(keepsSelection({ buttons: 0 }, { hasSelection: true, reportsMoves: true })).toBe(true);
  expect(keepsSelection({ buttons: 0 }, { hasSelection: false, reportsMoves: true })).toBe(false);
  // A drag with the button pressed makes or changes a selection, and xterm.js needs it.
  expect(keepsSelection({ buttons: 1 }, { hasSelection: true, reportsMoves: true })).toBe(false);
});

test("a mouse move goes on as usual when the program does not ask for moves, so links still respond to hover", () => {
  expect(keepsSelection({ buttons: 0 }, { hasSelection: true, reportsMoves: false })).toBe(false);
});

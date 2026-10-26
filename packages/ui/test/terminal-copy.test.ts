import { describe, expect, test } from "bun:test";
import { copiesSelection, keepsSelection, pastesClipboard } from "../src/lib/terminal-copy.ts";

const ctrlC = { type: "keydown", key: "c", ctrlKey: true, altKey: false, metaKey: false };
const ctrlV = { ...ctrlC, key: "v" };

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

describe("pasting into the session terminal", () => {
  test("outside macOS Ctrl+V and Ctrl+Shift+V paste the clipboard instead of sending Ctrl+V to the session", () => {
    expect(pastesClipboard(ctrlV, { mac: false })).toBe(true);
    expect(pastesClipboard({ ...ctrlV, key: "V" }, { mac: false })).toBe(true);
    expect(pastesClipboard({ ...ctrlV, type: "keyup" }, { mac: false })).toBe(false);
    expect(pastesClipboard({ ...ctrlV, altKey: true }, { mac: false })).toBe(false);
    expect(pastesClipboard({ ...ctrlV, ctrlKey: false }, { mac: false })).toBe(false);
  });

  test("on macOS Ctrl+V stays a key for the session, because Cmd+V pastes", () => {
    expect(pastesClipboard(ctrlV, { mac: true })).toBe(false);
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

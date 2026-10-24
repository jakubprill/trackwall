import { describe, expect, test } from "bun:test";
import { ariaPositionShortcut, nextWaitingShortcutLabel, positionShortcutLabel, sessionShortcut } from "../src/lib/session-shortcut.ts";

const none = { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const alt1 = { ...none, code: "Digit1", altKey: true };

describe("session shortcuts", () => {
  test("Alt + digit picks the entry at that position, Alt+J the next waiting session", () => {
    expect(sessionShortcut(alt1)).toEqual({ kind: "position", position: 1 });
    expect(sessionShortcut({ ...alt1, code: "Digit9" })).toEqual({ kind: "position", position: 9 });
    expect(sessionShortcut({ ...none, code: "KeyJ", altKey: true })).toEqual({ kind: "next-waiting" });
  });

  test("the key counts by position, so Option + digit on macOS (which types ¡) is a shortcut too", () => {
    expect(sessionShortcut({ ...alt1, key: "¡" } as typeof alt1)).toEqual({ kind: "position", position: 1 });
  });

  test("AltGr (Ctrl + Alt on Windows), Shift, ⌘ and a key without Alt are not shortcuts", () => {
    expect(sessionShortcut({ ...alt1, ctrlKey: true })).toBeUndefined();
    expect(sessionShortcut({ ...alt1, shiftKey: true })).toBeUndefined();
    expect(sessionShortcut({ ...alt1, metaKey: true })).toBeUndefined();
    expect(sessionShortcut({ ...alt1, altKey: false })).toBeUndefined();
  });

  test("Alt + 0, Alt + another letter and Alt + a keypad digit (a character code on Windows) are not shortcuts", () => {
    expect(sessionShortcut({ ...alt1, code: "Digit0" })).toBeUndefined();
    expect(sessionShortcut({ ...alt1, code: "KeyK" })).toBeUndefined();
    expect(sessionShortcut({ ...alt1, code: "Numpad1" })).toBeUndefined();
  });

  test("labels follow the system and end at position 9", () => {
    expect(positionShortcutLabel(1, false)).toBe("Alt+1");
    expect(positionShortcutLabel(1, true)).toBe("⌥1");
    expect(positionShortcutLabel(10, false)).toBeUndefined();
    expect(nextWaitingShortcutLabel(true)).toBe("⌥J");
    expect(ariaPositionShortcut(9)).toBe("Alt+9");
    expect(ariaPositionShortcut(10)).toBeUndefined();
  });
});

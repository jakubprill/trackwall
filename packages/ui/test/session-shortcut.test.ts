import { describe, expect, test } from "bun:test";
import { ariaSessionShortcut, sessionShortcut, sessionShortcutLabel } from "../src/lib/session-shortcut.ts";

const none = { code: "", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const alt1 = { ...none, code: "Digit1", key: "1", altKey: true };

describe("session shortcuts", () => {
  test("Alt + digit picks the entry at that position, Alt+J the next waiting session", () => {
    expect(sessionShortcut(alt1, false)).toEqual({ kind: "position", position: 1 });
    expect(sessionShortcut({ ...alt1, code: "Digit9", key: "9" }, false)).toEqual({ kind: "position", position: 9 });
    expect(sessionShortcut({ ...none, code: "KeyJ", key: "j", altKey: true }, false)).toEqual({ kind: "next-waiting" });
  });

  test("on macOS Option + key is a shortcut when it types a character beyond ASCII, like ¡ and ∆ on a US layout", () => {
    expect(sessionShortcut({ ...alt1, key: "¡" }, true)).toEqual({ kind: "position", position: 1 });
    expect(sessionShortcut({ ...none, code: "KeyJ", key: "∆", altKey: true }, true)).toEqual({ kind: "next-waiting" });
  });

  test("on macOS Option + key that types an ASCII character stays a key, so ⌥5 still types [ on a German layout", () => {
    expect(sessionShortcut({ ...alt1, code: "Digit5", key: "[" }, true)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, code: "Digit2", key: "@" }, true)).toBeUndefined();
  });

  test("AltGr (Ctrl + Alt on Windows), Shift, ⌘ and a key without Alt are not shortcuts", () => {
    expect(sessionShortcut({ ...alt1, ctrlKey: true }, false)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, shiftKey: true }, false)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, metaKey: true }, true)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, altKey: false }, false)).toBeUndefined();
  });

  test("Alt + 0, Alt + another letter and Alt + a keypad digit (a character code on Windows) are not shortcuts", () => {
    expect(sessionShortcut({ ...alt1, code: "Digit0", key: "0" }, false)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, code: "KeyK", key: "k" }, false)).toBeUndefined();
    expect(sessionShortcut({ ...alt1, code: "Numpad1" }, false)).toBeUndefined();
  });

  test("labels follow the system and end at position 9; aria-keyshortcuts always says Alt", () => {
    expect(sessionShortcutLabel({ kind: "position", position: 1 }, false)).toBe("Alt+1");
    expect(sessionShortcutLabel({ kind: "position", position: 1 }, true)).toBe("⌥1");
    expect(sessionShortcutLabel({ kind: "position", position: 10 }, false)).toBeUndefined();
    expect(sessionShortcutLabel({ kind: "next-waiting" }, true)).toBe("⌥J");
    expect(ariaSessionShortcut({ kind: "next-waiting" })).toBe("Alt+J");
    expect(ariaSessionShortcut({ kind: "position", position: 10 })).toBeUndefined();
  });
});

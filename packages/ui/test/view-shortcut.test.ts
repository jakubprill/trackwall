import { describe, expect, test } from "bun:test";
import { ariaShortcut, matchesShortcut, shortcutLabel } from "../src/lib/view-shortcut.ts";

const repos = { code: "Digit1", key: "1" };
const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("skróty widoków", () => {
  test("na Windowsie widok przełącza Ctrl + klawisz, a ⌘ nie", () => {
    expect(matchesShortcut({ ...none, code: "Digit1", ctrlKey: true }, repos, false)).toBe(true);
    expect(matchesShortcut({ ...none, code: "Digit1", metaKey: true }, repos, false)).toBe(false);
  });

  test("na macOS widok przełącza ⌘ + klawisz, a Ctrl nie", () => {
    expect(matchesShortcut({ ...none, code: "Digit1", metaKey: true }, repos, true)).toBe(true);
    expect(matchesShortcut({ ...none, code: "Digit1", ctrlKey: true }, repos, true)).toBe(false);
  });

  test("Shift, Alt, sam klawisz i inny klawisz nie przełączają widoku", () => {
    expect(matchesShortcut({ ...none, code: "Digit1", ctrlKey: true, shiftKey: true }, repos, false)).toBe(false);
    expect(matchesShortcut({ ...none, code: "Digit1", ctrlKey: true, altKey: true }, repos, false)).toBe(false);
    expect(matchesShortcut({ ...none, code: "Digit1" }, repos, false)).toBe(false);
    expect(matchesShortcut({ ...none, code: "Digit2", ctrlKey: true }, repos, false)).toBe(false);
  });

  test("podpis skrótu w konwencji systemu", () => {
    expect(shortcutLabel(repos, false)).toBe("Ctrl+1");
    expect(shortcutLabel(repos, true)).toBe("⌘1");
    expect(ariaShortcut({ code: "Comma", key: "," }, false)).toBe("Control+,");
    expect(ariaShortcut(repos, true)).toBe("Meta+1");
  });
});

import { describe, expect, test } from "bun:test";
import { ariaShortcut, matchesShortcut, shortcutLabel } from "../src/lib/view-shortcut.ts";

const none = { code: "", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const ctrl1 = { ...none, code: "Digit1", key: "1", ctrlKey: true };

describe("skróty widoków", () => {
  test("na Windowsie widok przełącza Ctrl + klawisz, a ⌘ nie", () => {
    expect(matchesShortcut(ctrl1, "1", false)).toBe(true);
    expect(matchesShortcut({ ...ctrl1, ctrlKey: false, metaKey: true }, "1", false)).toBe(false);
  });

  test("na macOS widok przełącza ⌘ + klawisz, a Ctrl nie", () => {
    expect(matchesShortcut({ ...ctrl1, ctrlKey: false, metaKey: true }, "1", true)).toBe(true);
    expect(matchesShortcut(ctrl1, "1", true)).toBe(false);
  });

  test("Shift, Alt, sam klawisz i inny klawisz nie przełączają widoku", () => {
    expect(matchesShortcut({ ...ctrl1, shiftKey: true }, "1", false)).toBe(false);
    expect(matchesShortcut({ ...ctrl1, altKey: true }, "1", false)).toBe(false);
    expect(matchesShortcut({ ...ctrl1, ctrlKey: false }, "1", false)).toBe(false);
    expect(matchesShortcut(ctrl1, "2", false)).toBe(false);
  });

  test("cyfra liczy się po klawiszu, także gdy układ (AZERTY) daje bez Shift inny znak", () => {
    expect(matchesShortcut({ ...ctrl1, key: "&" }, "1", false)).toBe(true);
  });

  test("cyfra z klawiatury numerycznej przełącza widok tylko przy włączonym NumLock", () => {
    expect(matchesShortcut({ ...ctrl1, code: "Numpad1" }, "1", false)).toBe(true);
    expect(matchesShortcut({ ...ctrl1, code: "Numpad1", key: "End" }, "1", false)).toBe(false);
  });

  test("przecinek liczy się po znaku, a nie po klawiszu, na którym w innym układzie leży litera", () => {
    expect(matchesShortcut({ ...none, code: "KeyM", key: ",", ctrlKey: true }, ",", false)).toBe(true);
    expect(matchesShortcut({ ...none, code: "Comma", key: ";", ctrlKey: true }, ",", false)).toBe(false);
    expect(matchesShortcut({ ...none, code: "Comma", key: "w", ctrlKey: true }, ",", false)).toBe(false);
  });

  test("podpis skrótu w konwencji systemu", () => {
    expect(shortcutLabel("1", false)).toBe("Ctrl+1");
    expect(shortcutLabel("1", true)).toBe("⌘1");
    expect(ariaShortcut(",", false)).toBe("Control+,");
    expect(ariaShortcut("1", true)).toBe("Meta+1");
  });
});

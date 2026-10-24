import { describe, expect, test } from "bun:test";
import { ariaShortcut, matchesNewWindowShortcut, matchesShortcut, shortcutLabel, viewKeyAction } from "../src/lib/view-shortcut.ts";

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

describe("new window shortcuts", () => {
  const views = [
    { id: "home", shortcut: "1" },
    { id: "sessions", shortcut: "3" },
    { id: "settings", shortcut: "," },
  ] as const;
  const windows = { isMac: false, newWindows: true };
  const ctrlShift3 = { ...none, code: "Digit3", key: "#", ctrlKey: true, shiftKey: true, repeat: false };

  test("Ctrl+Shift and a view's digit open that view in a new window", () => {
    expect(viewKeyAction(ctrlShift3, views, "home", windows)).toEqual({ kind: "new-window", id: "sessions" });
  });

  test("Ctrl and a view's digit switch this window's view", () => {
    expect(viewKeyAction({ ...ctrlShift3, shiftKey: false, key: "3" }, views, "home", windows)).toEqual({
      kind: "select",
      id: "sessions",
    });
  });

  test("Ctrl+Shift+N opens the current view in a new window, by the character in any layout", () => {
    const ctrlShiftN = { ...none, code: "KeyB", key: "N", ctrlKey: true, shiftKey: true, repeat: false };
    expect(viewKeyAction(ctrlShiftN, views, "sessions", windows)).toEqual({ kind: "new-window", id: "sessions" });
    expect(viewKeyAction({ ...ctrlShiftN, altKey: true }, views, "sessions", windows)).toBeUndefined();
  });

  test("on macOS a view opens in a new window with ⌥⌘ and a digit, because ⌘⇧3 and ⌘⇧4 take screenshots", () => {
    const mac = { isMac: true, newWindows: true };
    const optionCommand3 = { ...none, code: "Digit3", key: "£", metaKey: true, altKey: true, repeat: false };
    expect(viewKeyAction(optionCommand3, views, "home", mac)).toEqual({ kind: "new-window", id: "sessions" });
    expect(viewKeyAction({ ...optionCommand3, altKey: false, shiftKey: true }, views, "home", mac)).toBeUndefined();
  });

  test("a held key does not open a window per autorepeat", () => {
    expect(viewKeyAction({ ...ctrlShift3, repeat: true }, views, "home", windows)).toBeUndefined();
  });

  test("without windows to open (the UI in a browser) new-window shortcuts do nothing", () => {
    expect(viewKeyAction(ctrlShift3, views, "home", { isMac: false, newWindows: false })).toBeUndefined();
  });

  test("Settings has no new-window shortcut", () => {
    expect(matchesNewWindowShortcut({ ...none, key: ",", ctrlKey: true, shiftKey: true }, ",", false)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { steppedTab, tabShortcut, tabShortcutLabel } from "../src/lib/tab-shortcut.ts";

const none = { code: "", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const ctrlPageDown = { ...none, code: "PageDown", key: "PageDown", ctrlKey: true };
const ctrlPageUp = { ...none, code: "PageUp", key: "PageUp", ctrlKey: true };
const cmdShiftRight = { ...none, code: "BracketRight", key: "}", metaKey: true, shiftKey: true };

describe("tab shortcuts", () => {
  test("Ctrl+PageDown opens the next tab and Ctrl+PageUp the previous one, on every system", () => {
    expect(tabShortcut(ctrlPageDown, false)).toBe("next");
    expect(tabShortcut(ctrlPageUp, false)).toBe("previous");
    expect(tabShortcut(ctrlPageDown, true)).toBe("next");
  });

  test("PageUp and PageDown alone stay keys, because Copilot CLI scrolls its timeline with them", () => {
    expect(tabShortcut({ ...ctrlPageDown, ctrlKey: false }, false)).toBeUndefined();
    expect(tabShortcut({ ...ctrlPageUp, ctrlKey: false }, true)).toBeUndefined();
  });

  test("Ctrl+Shift+PageDown, Ctrl+Alt+PageDown and ⌘ + PageDown are not shortcuts", () => {
    expect(tabShortcut({ ...ctrlPageDown, shiftKey: true }, false)).toBeUndefined();
    expect(tabShortcut({ ...ctrlPageDown, altKey: true }, false)).toBeUndefined();
    expect(tabShortcut({ ...ctrlPageDown, ctrlKey: false, metaKey: true }, true)).toBeUndefined();
  });

  test("on macOS ⌘⇧] and ⌘⇧[ step through tabs by key position, whatever character the layout puts there", () => {
    expect(tabShortcut(cmdShiftRight, true)).toBe("next");
    expect(tabShortcut({ ...cmdShiftRight, code: "BracketLeft", key: "{" }, true)).toBe("previous");
    expect(tabShortcut({ ...cmdShiftRight, key: "*" }, true)).toBe("next");
  });

  test("⌘] without Shift, ⌃⇧] and the brackets outside macOS are not shortcuts", () => {
    expect(tabShortcut({ ...cmdShiftRight, shiftKey: false, key: "]" }, true)).toBeUndefined();
    expect(tabShortcut({ ...cmdShiftRight, metaKey: false, ctrlKey: true }, true)).toBeUndefined();
    expect(tabShortcut(cmdShiftRight, false)).toBeUndefined();
  });

  test("the next tab after Terminal is Shell, and the previous one before Shell is Terminal", () => {
    const tabs = [{ id: "session" }, { id: "shell" }, { id: "changes" }] as const;
    expect(steppedTab(tabs, "session", "next")).toBe("shell");
    expect(steppedTab(tabs, "shell", "previous")).toBe("session");
  });

  test("stepping wraps around at both ends, and an active tab that is not listed stays", () => {
    const tabs = [{ id: "session" }, { id: "shell" }, { id: "changes" }] as const;
    expect(steppedTab(tabs, "changes", "next")).toBe("session");
    expect(steppedTab(tabs, "session", "previous")).toBe("changes");
    expect(steppedTab<string>(tabs, "rounds", "next")).toBe("rounds");
  });

  test("the caption follows the system's convention", () => {
    expect(tabShortcutLabel(false)).toBe("Ctrl+PageDown / Ctrl+PageUp");
    expect(tabShortcutLabel(true)).toBe("⌘⇧] / ⌘⇧[");
  });
});

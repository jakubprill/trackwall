import { describe, expect, test } from "bun:test";
import { ideaShortcutLabel, isIdeaShortcut } from "../src/lib/idea-shortcut.ts";

const none = { code: "", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("the idea shortcut (ADR-133)", () => {
  test("Alt+N opens the idea line, by the key's position, also where Option types a dead key on macOS", () => {
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "n", altKey: true }, false)).toBe(true);
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "Dead", altKey: true }, true)).toBe(true);
    expect(ideaShortcutLabel(true)).toBe("⌥N");
    expect(ideaShortcutLabel(false)).toBe("Alt+N");
  });

  test("other modifiers, another key, and Option typing an ASCII character on macOS stay ordinary key presses", () => {
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "n" }, false)).toBe(false);
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "N", altKey: true, shiftKey: true }, false)).toBe(false);
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "n", altKey: true, ctrlKey: true }, false)).toBe(false);
    expect(isIdeaShortcut({ ...none, code: "KeyM", key: "m", altKey: true }, false)).toBe(false);
    expect(isIdeaShortcut({ ...none, code: "KeyN", key: "~", altKey: true }, true)).toBe(false);
  });
});

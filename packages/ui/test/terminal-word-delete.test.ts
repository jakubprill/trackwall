import { describe, expect, test } from "bun:test";
import { DELETE_WORD_BEFORE, deletesWordBefore } from "../src/lib/terminal-word-delete.ts";

const key = (name: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}, type = "keydown") => ({
  type,
  key: name,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("Ctrl+Backspace in a session terminal", () => {
  test("Ctrl+Backspace deletes the word before the cursor, sent as Ctrl+W", () => {
    expect(deletesWordBefore(key("Backspace", { ctrlKey: true }))).toBe(true);
    expect(DELETE_WORD_BEFORE).toBe("\u0017");
  });

  test("Backspace alone, Alt+Backspace and Shift+Backspace stay what xterm.js sends", () => {
    expect(deletesWordBefore(key("Backspace"))).toBe(false);
    expect(deletesWordBefore(key("Backspace", { altKey: true }))).toBe(false);
    expect(deletesWordBefore(key("Backspace", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(deletesWordBefore(key("Backspace", { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  test("only the key going down counts, and Ctrl with another key is not it", () => {
    expect(deletesWordBefore(key("Backspace", { ctrlKey: true }, "keyup"))).toBe(false);
    expect(deletesWordBefore(key("Delete", { ctrlKey: true }))).toBe(false);
  });
});

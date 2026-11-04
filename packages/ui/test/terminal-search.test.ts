import { describe, expect, test } from "bun:test";
import { opensSearch, searchKeyAction } from "../src/lib/terminal-search.ts";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}, type = "keydown") => ({
  type,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("opening the search in a terminal", () => {
  test("Ctrl+Shift+F opens it on Windows and Linux, while Ctrl+F stays the shell's", () => {
    expect(opensSearch(key("KeyF", { ctrlKey: true, shiftKey: true }), { mac: false })).toBe(true);
    expect(opensSearch(key("KeyF", { ctrlKey: true }), { mac: false })).toBe(false);
    expect(opensSearch(key("KeyF", { metaKey: true }), { mac: false })).toBe(false);
  });

  test("Cmd+F opens it on macOS, while Ctrl+F stays the shell's", () => {
    expect(opensSearch(key("KeyF", { metaKey: true }), { mac: true })).toBe(true);
    expect(opensSearch(key("KeyF", { ctrlKey: true }), { mac: true })).toBe(false);
  });

  test("the key is found by its place, so a keyboard layout that types another letter there opens it too", () => {
    expect(opensSearch(key("KeyF", { metaKey: true }), { mac: true })).toBe(true);
    expect(opensSearch(key("KeyA", { metaKey: true }), { mac: true })).toBe(false);
  });

  test("only the key going down opens it, and never with Alt", () => {
    expect(opensSearch(key("KeyF", { metaKey: true }, "keyup"), { mac: true })).toBe(false);
    expect(opensSearch(key("KeyF", { ctrlKey: true, shiftKey: true, altKey: true }), { mac: false })).toBe(false);
  });
});

describe("keys in the search field", () => {
  test("Enter looks up from the newest output, Shift+Enter down, Escape closes, other keys type", () => {
    expect(searchKeyAction({ key: "Enter", shiftKey: false })).toBe("previous");
    expect(searchKeyAction({ key: "Enter", shiftKey: true })).toBe("next");
    expect(searchKeyAction({ key: "Escape", shiftKey: false })).toBe("close");
    expect(searchKeyAction({ key: "a", shiftKey: false })).toBeUndefined();
  });
});

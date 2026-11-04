import { describe, expect, test } from "bun:test";
import { opensSearch, searchKeyAction } from "../src/lib/terminal-search.ts";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}, type = "keydown") => ({
  type,
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("opening the search in a terminal", () => {
  test("Ctrl+Shift+F opens it on Windows and Linux, while Ctrl+F stays the shell's", () => {
    expect(opensSearch(key("F", { ctrlKey: true, shiftKey: true }), { mac: false })).toBe(true);
    expect(opensSearch(key("f", { ctrlKey: true }), { mac: false })).toBe(false);
    expect(opensSearch(key("f", { metaKey: true }), { mac: false })).toBe(false);
  });

  test("Cmd+F opens it on macOS, while Ctrl+F stays the shell's", () => {
    expect(opensSearch(key("f", { metaKey: true }), { mac: true })).toBe(true);
    expect(opensSearch(key("f", { ctrlKey: true }), { mac: true })).toBe(false);
  });

  test("only the key going down opens it, and never with Alt", () => {
    expect(opensSearch(key("f", { metaKey: true }, "keyup"), { mac: true })).toBe(false);
    expect(opensSearch(key("f", { ctrlKey: true, shiftKey: true, altKey: true }), { mac: false })).toBe(false);
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

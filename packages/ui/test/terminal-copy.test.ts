import { describe, expect, test } from "bun:test";
import { copiesSelection } from "../src/lib/terminal-copy.ts";

const ctrlC = { type: "keydown", key: "c", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };

describe("kopiowanie z terminala sesji", () => {
  test("na Windowsie Ctrl+C i Ctrl+Shift+C kopiują zaznaczenie, a Ctrl+C bez zaznaczenia przerywa pracę sesji", () => {
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection({ ...ctrlC, key: "C", shiftKey: true }, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: false })).toBe(false);
    expect(copiesSelection({ ...ctrlC, type: "keyup" }, { mac: false, hasSelection: true })).toBe(false);
  });

  test("na macOS Ctrl+C zostaje przerwaniem, bo kopiuje Cmd+C", () => {
    expect(copiesSelection(ctrlC, { mac: true, hasSelection: true })).toBe(false);
  });
});

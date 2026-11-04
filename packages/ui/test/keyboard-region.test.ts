import { describe, expect, test } from "bun:test";
import { KEYBOARD_REGION, keyboardInRegion } from "../src/lib/keyboard-elsewhere.ts";

/** A page of named nodes: the supervisor panel holds its message box and an approval's option; the view beside it does not. */
const panel = { name: "panel", holds: ["message box", "Allow once"] };
const inPanel = (name: string) => ({
  name,
  closest: (selector: string) =>
    selector === `[${KEYBOARD_REGION}]` ? { contains: (node: string | null) => node !== null && panel.holds.includes(node) } : null,
});
const outsideAnyRegion = { closest: () => null };

describe("whether the keyboard is already in the supervisor panel", () => {
  test("an option of an approval in the panel keeps the keyboard, so the message box does not take it", () => {
    expect(keyboardInRegion(inPanel("message box"), "Allow once")).toBe(true);
  });

  test("the keyboard in a view beside the panel, as on Alt+0, or on nothing lets the panel's screen take it", () => {
    expect(keyboardInRegion(inPanel("message box"), "a session terminal in Sessions")).toBe(false);
    expect(keyboardInRegion(inPanel("message box"), null)).toBe(false);
  });

  test("a screen outside any region always takes the keyboard, as before", () => {
    expect(keyboardInRegion(outsideAnyRegion, "a button next to it")).toBe(false);
  });
});

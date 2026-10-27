import { describe, expect, test } from "bun:test";
import { asksProgramToCopy, copiesSelection, keepsSelection, osc52Text, ProgramCopy, pastesClipboard } from "../src/lib/terminal-copy.ts";

const ctrlC = { type: "keydown", key: "c", ctrlKey: true, altKey: false, metaKey: false };
const ctrlV = { ...ctrlC, key: "v" };

describe("copying from the session terminal", () => {
  test("on Windows Ctrl+C and Ctrl+Shift+C copy the selection, and Ctrl+C without a selection interrupts the session", () => {
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection({ ...ctrlC, key: "C" }, { mac: false, hasSelection: true })).toBe(true);
    expect(copiesSelection(ctrlC, { mac: false, hasSelection: false })).toBe(false);
    expect(copiesSelection({ ...ctrlC, type: "keyup" }, { mac: false, hasSelection: true })).toBe(false);
  });

  test("on macOS Ctrl+C stays an interrupt, because Cmd+C copies", () => {
    expect(copiesSelection(ctrlC, { mac: true, hasSelection: true })).toBe(false);
  });
});

describe("pasting into the session terminal", () => {
  test("outside macOS Ctrl+V and Ctrl+Shift+V paste the clipboard instead of sending Ctrl+V to the session", () => {
    expect(pastesClipboard(ctrlV, { mac: false })).toBe(true);
    expect(pastesClipboard({ ...ctrlV, key: "V" }, { mac: false })).toBe(true);
    expect(pastesClipboard({ ...ctrlV, type: "keyup" }, { mac: false })).toBe(false);
    expect(pastesClipboard({ ...ctrlV, altKey: true }, { mac: false })).toBe(false);
    expect(pastesClipboard({ ...ctrlV, ctrlKey: false }, { mac: false })).toBe(false);
  });

  test("on macOS Ctrl+V stays a key for the session, because Cmd+V pastes", () => {
    expect(pastesClipboard(ctrlV, { mac: true })).toBe(false);
  });
});

test("a mouse move over selected text does not reach Copilot CLI, so the selection stays until it is copied", () => {
  expect(keepsSelection({ buttons: 0 }, { hasSelection: true, reportsMoves: true })).toBe(true);
  expect(keepsSelection({ buttons: 0 }, { hasSelection: false, reportsMoves: true })).toBe(false);
  // A drag with the button pressed makes or changes a selection, and xterm.js needs it.
  expect(keepsSelection({ buttons: 1 }, { hasSelection: true, reportsMoves: true })).toBe(false);
});

test("a mouse move goes on as usual when the program does not ask for moves, so links still respond to hover", () => {
  expect(keepsSelection({ buttons: 0 }, { hasSelection: true, reportsMoves: false })).toBe(false);
});

describe("copying what Copilot CLI selected itself (OSC 52)", () => {
  test("the clipboard target with base64 text is the text to copy, Polish letters and new lines included", () => {
    // What Copilot CLI 1.0.104 sends on Ctrl+C after the user selected "Zażółć\ngęślą" with the mouse.
    expect(osc52Text(`c;${Buffer.from("Zażółć\ngęślą").toString("base64")}`)).toBe("Zażółć\ngęślą");
    expect(osc52Text(`pc;${Buffer.from("both").toString("base64")}`)).toBe("both");
    expect(osc52Text(`;${Buffer.from("no target").toString("base64")}`)).toBe("no target");
  });

  test("the primary selection Copilot CLI sets on mouse release, a clipboard query and an empty payload copy nothing", () => {
    expect(osc52Text(`p!;${Buffer.from("selected").toString("base64")};`)).toBeUndefined();
    expect(osc52Text("c;?")).toBeUndefined();
    expect(osc52Text("c;")).toBeUndefined();
    expect(osc52Text("c")).toBeUndefined();
  });

  test("a payload that is not base64 of UTF-8 text copies nothing", () => {
    expect(osc52Text("c;not base64!")).toBeUndefined();
    expect(osc52Text(`c;${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeUndefined();
  });

  test("a trailing semicolon after the payload does not lose the copy", () => {
    expect(osc52Text(`c;${Buffer.from("text").toString("base64")};`)).toBe("text");
  });

  test("Ctrl+C that goes to the program and a right click ask it to copy; typing, other clicks and our own copy do not", () => {
    const off = { mac: false, hasSelection: false };
    expect(asksProgramToCopy({ kind: "key", key: ctrlC }, off)).toBe(true);
    expect(asksProgramToCopy({ kind: "key", key: ctrlC }, { mac: true, hasSelection: true })).toBe(true);
    expect(asksProgramToCopy({ kind: "pointer", button: 2 }, off)).toBe(true);
    // With an xterm.js selection on Windows, Ctrl+C is the terminal's own copy and never reaches the program.
    expect(asksProgramToCopy({ kind: "key", key: ctrlC }, { mac: false, hasSelection: true })).toBe(false);
    expect(asksProgramToCopy({ kind: "key", key: { ...ctrlC, key: "a" } }, off)).toBe(false);
    expect(asksProgramToCopy({ kind: "key", key: { ...ctrlC, type: "keyup" } }, off)).toBe(false);
    expect(asksProgramToCopy({ kind: "pointer", button: 0 }, off)).toBe(false);
  });

  test("one request takes one copy, and only within a second", () => {
    const copy = new ProgramCopy();
    expect(copy.take(1_000)).toBe(false);
    copy.asked(10_000);
    expect(copy.take(10_005)).toBe(true);
    expect(copy.take(10_006)).toBe(false);
    copy.asked(20_000);
    expect(copy.take(21_001)).toBe(false);
  });
});

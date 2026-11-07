import { describe, expect, test } from "bun:test";
import {
  asksProgramToCopy,
  copiesSelection,
  entersCopyCommand,
  keepsSelection,
  osc52Text,
  ProgramCopy,
  pastesClipboard,
} from "../src/lib/terminal-copy.ts";

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

describe("Enter on Copilot CLI's /copy", () => {
  const enter = { type: "keydown", key: "Enter", ctrlKey: false, altKey: false, metaKey: false };
  const rule = "─".repeat(40);
  const footer = " Interactive · Manual Approval · /help show help";
  // The bottom of Copilot CLI 1.0.103's screen: the input box between two rules, then the footer.
  const box = (text: string) => () => [" ● Here is the answer", rule, `❯ ${text}`, rule, footer];

  test("asks the program to copy when the input box holds /copy", () => {
    expect(entersCopyCommand(enter, box("/copy"))).toBe(true);
  });

  test("in the framed input box, which has no ❯, /copy asks too", () => {
    // Copilot CLI's framed box (ADR-220): the rail on the left, between a row of ▄ and a row of ▀.
    const framed = (text: string) => () => [" ● Here is the answer", `╻${"▄".repeat(39)}`, `┃ ${text}`, `╹${"▀".repeat(39)}`, footer];
    expect(entersCopyCommand(enter, framed("/copy"))).toBe(true);
    expect(entersCopyCommand(enter, framed("/collect-debug-logs"))).toBe(false);
  });

  test("with the command menu open, the box shows the command Enter picks, so typing /co counts too", () => {
    const menu = () => ["┃ ❯ /copy                 Copy the last response to the clipboard", rule, "❯ /copy", rule, footer];
    expect(entersCopyCommand(enter, menu)).toBe(true);
  });

  test("another command, a prompt, an empty box and a screen without the box do not ask", () => {
    // Other commands print repo or session content, whose OSC 52 must not fill the clipboard.
    expect(entersCopyCommand(enter, box("/collect-debug-logs"))).toBe(false);
    expect(entersCopyCommand(enter, box("/diff"))).toBe(false);
    expect(entersCopyCommand(enter, box("copy this to the clipboard"))).toBe(false);
    expect(entersCopyCommand(enter, box(""))).toBe(false);
    expect(entersCopyCommand(enter, () => [" ● Working · 3s"])).toBe(false);
  });

  test("other keys, Enter with a modifier and the key going up do not ask, and only Enter reads the screen", () => {
    let read = 0;
    const counted = () => {
      read++;
      return box("/copy")();
    };
    expect(entersCopyCommand({ ...enter, key: "a" }, counted)).toBe(false);
    expect(entersCopyCommand({ ...enter, ctrlKey: true }, counted)).toBe(false);
    expect(entersCopyCommand({ ...enter, type: "keyup" }, counted)).toBe(false);
    expect(read).toBe(0);
  });
});

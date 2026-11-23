import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { promptBoxText } from "@trackwall/protocol";
import { viewer, waitFor } from "../test/support/agents.ts";
import { REFERENCE_COLS, REFERENCE_ROWS } from "../test/support/copilot-reference.ts";
import { screenLines, untilInputBox } from "../test/support/screen-lines.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// The keys that edit a word in Copilot CLI's input box, as the session terminal's xterm.js sends them. The session
// terminal sends Ctrl+Backspace as Ctrl+W (`packages/ui/src/lib/terminal-word-delete.ts`), because the `^H` xterm.js
// sends for it deletes one character in Copilot CLI on macOS and Linux (on Windows ConPTY turns it into the
// Ctrl+Backspace key, which deletes a word, so Ctrl+W is right on every system); the other keys go as xterm.js sends them,
// and these tests show that Copilot CLI edits a word on each. A Copilot CLI that changes one of them fails here.

const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
let window: ReturnType<typeof viewer>;

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model);
  const { agents } = daemon.facade;
  const supervisor = await agents.startSupervisor("new", "terminal");
  window = viewer(agents, supervisor.id);
  window.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
  await waitFor(agents, supervisor.id, (s) => s.state !== null, "the input box of a new supervisor", SESSION_MS);
  await untilInputBox(window, "empty");
});

afterAll(async () => {
  window.attachment.detach();
  await daemon.stop();
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
  await model.close();
});

/**
 * The text in the input box once it is `expected`, or the last text read when it does not get there in time: Copilot
 * CLI draws a key's effect a moment after it gets it.
 */
async function boxText(expected: string): Promise<string | undefined> {
  const until = Date.now() + 10_000;
  let text = promptBoxText(await screenLines(window));
  while (text !== expected && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = promptBoxText(await screenLines(window));
  }
  return text;
}

/** Empties the input box (End, then more Backspaces than it holds, as DEL, what xterm.js sends) and types `text`. */
async function typeIntoEmptyBox(text: string): Promise<void> {
  window.attachment.input(`\x1b[F${"\x7f".repeat(80)}`);
  expect(await boxText("")).toBe("");
  window.attachment.input(text);
  expect(await boxText(text)).toBe(text);
}

const LEFT = "\x1b[D";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";

describe("editing a word in Copilot CLI's input box with the real Copilot CLI", () => {
  test("Ctrl+W deletes the word before the cursor, so the session terminal sends it for Ctrl+Backspace", async () => {
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input("\x17");
    expect(await boxText("alpha beta")).toBe("alpha beta");
  });

  test("^H, what xterm.js sends for Ctrl+Backspace, deletes only one character outside Windows, where ConPTY makes it a word", async () => {
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input("\x08");
    const expected = process.platform === "win32" ? "alpha beta" : "alpha beta gamm";
    expect(await boxText(expected)).toBe(expected);
  });

  test("Alt+Backspace (ESC DEL) deletes the word before the cursor too", async () => {
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input("\x1b\x7f");
    expect(await boxText("alpha beta")).toBe("alpha beta");
  });

  test("Ctrl+Delete (CSI 3;5~) deletes the word after the cursor", async () => {
    // Ten characters left from the end is before "beta".
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input(`${LEFT.repeat(10)}\x1b[3;5~`);
    expect(await boxText("alpha  gamma")).toBe("alpha  gamma");
  });

  test("Ctrl+Left and Ctrl+Right (CSI 1;5D, CSI 1;5C) move the cursor a word at a time", async () => {
    // Two words left from the end is before "beta"; one word right from there is past it.
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input(`${CTRL_LEFT}${CTRL_LEFT}X`);
    expect(await boxText("alpha Xbeta gamma")).toBe("alpha Xbeta gamma");
    await typeIntoEmptyBox("alpha beta gamma");
    window.attachment.input(`${CTRL_LEFT}${CTRL_LEFT}${CTRL_RIGHT}Y`);
    expect(await boxText("alpha beta Ygamma")).toBe("alpha beta Ygamma");
  });
});

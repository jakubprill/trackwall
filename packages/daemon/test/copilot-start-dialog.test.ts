import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStateChange } from "@trackwall/protocol";
import { readAgentDialog } from "../src/modules/agents/copilot-dialog.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";

/**
 * Screens of Copilot CLI taken from the real binary in the daemon's emulator: the folder trust dialog of 1.0.103 (the
 * folder path replaced), and the certificate authority dialog of 1.0.107 on Linux with the offer forced and the macOS
 * texts, which only macOS and Windows show (`copilot-start-dialog.ts`).
 */
function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "copilot", `${name}.txt`), "utf8").split("\n");
}

const trust = screen("dialog-folder-trust-120");
const certificate = screen("dialog-sandbox-ca-120");
const box = screen("prompt-box-120");

const summary = (changes: TaskStateChange[]) => changes.map((c) => `${c.state} ${c.source} ${c.confidence} ${c.reason}`);

function sessionState(promptOnStart: boolean) {
  return new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart, program: null });
}

describe("Copilot CLI asking to trust its folder, read from the screen", () => {
  test("the dialog reads like an approval: the folder, the question and the options answered with a digit", () => {
    expect(readAgentDialog(trust, "approval")).toEqual({
      kind: "approval",
      title: "Confirm folder trust",
      detail: [
        "/home/me/projects/shop",
        "",
        "Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will",
        "remember your permissions for the rest of this session.",
      ],
      question: "Do you trust the files in this folder?",
      options: [
        { key: "1", label: "Yes" },
        { key: "2", label: "Yes, and remember this folder for future sessions" },
      ],
    });
  });

  test("a new session showing the dialog waits for you, and after the answer its input box does", () => {
    const session = sessionState(false);

    expect(summary(session.screen(() => trust))).toEqual(["Approval screen medium screen folder trust dialog"]);
    expect(summary(session.key("choice"))).toEqual(["Working keyboard medium key choice"]);
    expect(summary(session.screen(() => box))).toEqual(["Input screen medium screen input box before the first prompt"]);
    expect(session.screenSpeaks).toBe(false);
  });

  test("a dialog still on the screen right after the answer does not ask again", () => {
    const session = sessionState(false);
    session.screen(() => trust);
    session.key("choice");

    expect(session.screen(() => trust)).toEqual([]);
    expect(summary(session.screen(() => box))).toEqual(["Input screen medium screen input box before the first prompt"]);
  });

  test("a key pressed before the screen showed the dialog answered it, so the dialog not redrawn yet does not ask", () => {
    const session = sessionState(false);
    session.key("enter");

    expect(session.screen(() => trust)).toEqual([]);
    expect(summary(session.screen(() => box))).toEqual(["Input screen medium screen input box before the first prompt"]);
  });

  test("while the dialog waits the screen is not read again", () => {
    const session = sessionState(false);
    session.screen(() => trust);

    expect(session.screenSpeaks).toBe(false);
  });

  test("a session starting with a prompt waits for the answer too, and its prompt then starts work", () => {
    const task = sessionState(true);

    expect(summary(task.screen(() => trust))).toEqual(["Approval screen medium screen folder trust dialog"]);
    task.key("choice");
    expect(task.screen(() => box)).toEqual([]);
    expect(summary(task.hook({ event: "sessionStart", receivedAt: 0, payload: {}, omitted: [] }))).toEqual([
      "Working hook medium hook sessionStart with a prompt",
    ]);
  });

  test("after the first hook the screen no longer says the session waits for its folder", () => {
    const session = sessionState(false);
    session.hook({ event: "sessionStart", receivedAt: 0, payload: {}, omitted: [] });

    expect(session.screenSpeaks).toBe(false);
    expect(session.screen(() => trust)).toEqual([]);
  });

  test("an approval of a command is no folder trust dialog", () => {
    expect(
      sessionState(false)
        .screen(() => screen("dialog-shell-120"))
        .map((c) => c.state),
    ).not.toContain("Approval");
  });
});

describe("Copilot CLI's sandbox offering to install its certificate authority, read from the screen (ADR-181)", () => {
  test("the dialog reads like an approval whose only answer outside the terminal is to continue without installing", () => {
    const dialog = readAgentDialog(certificate, "approval");

    expect(dialog).toMatchObject({
      kind: "approval",
      title: "Install the proxy certificate authority?",
      question:
        "You can install it later with /sandbox ca create and /sandbox ca trust, or under Network, Proxy and blocking, Certificate authority in /sandbox.",
      options: [{ key: "2", label: "Continue without installing (Esc)" }],
    });
    expect(dialog?.kind === "approval" && dialog.detail.at(-1)).toBe(
      "macOS asks for your login password whenever it changes Keychain trust settings.",
    );
  });

  test("in a short terminal Copilot CLI scrolls the dialog's text, and the dialog still waits with no option but Stop outside the terminal", () => {
    expect(readAgentDialog(screen("dialog-sandbox-ca-80"), "approval")).toMatchObject({
      kind: "approval",
      title: "Install the proxy certificate authority?",
      options: [],
    });
  });

  test("a task showing the dialog before its first hook waits for you, and after the answer its prompt starts work", () => {
    const task = sessionState(true);

    expect(summary(task.screen(() => certificate))).toEqual(["Approval screen medium screen sandbox certificate authority dialog"]);
    expect(task.screenSpeaks).toBe(false);
    task.key("choice");
    expect(task.screen(() => certificate)).toEqual([]);
    expect(summary(task.hook({ event: "sessionStart", receivedAt: 0, payload: {}, omitted: [] }))).toEqual([
      "Working hook medium hook sessionStart with a prompt",
    ]);
  });

  test("after the folder trust dialog is answered the certificate authority dialog waits for you again", () => {
    const task = sessionState(true);
    task.screen(() => trust);
    task.key("choice");

    expect(task.screen(() => trust)).toEqual([]);
    expect(summary(task.screen(() => certificate))).toEqual(["Approval screen medium screen sandbox certificate authority dialog"]);
  });
});

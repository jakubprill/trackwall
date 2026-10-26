import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promptBoxOnScreen } from "../src/modules/agents/copilot-prompt-box.ts";
import { CopilotSessionState, RETYPE_AFTER_MS } from "../src/modules/agents/copilot-session-state.ts";

/** Screens of Copilot CLI 1.0.103 taken from the real binary in the daemon's emulator (the repo path replaced). */
function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "copilot", `${name}.txt`), "utf8").split("\n");
}

const box = screen("prompt-box-120");
const withText = box.map((l) => (l.trim() === "❯" ? "❯ read the review" : l));

describe("Copilot CLI waiting in its input box, read from the screen (ADR-69)", () => {
  test("a new session ready for its first prompt shows the empty input box over the footer with hints, in a wide and a narrow terminal", () => {
    expect(promptBoxOnScreen(box)).toBe("empty");
    expect(promptBoxOnScreen(screen("prompt-box-72"))).toBe("empty");
    expect(promptBoxOnScreen(withText)).toBe("text");
  });

  test("the input box over a status line is not ready: Copilot CLI is still loading, or working, in every frame of its bullet", () => {
    expect(promptBoxOnScreen(screen("prompt-box-loading-120"))).toBeUndefined();
    expect(promptBoxOnScreen(screen("prompt-box-working-120"))).toBeUndefined();
    for (const frame of ["◉", "◎", "○"]) {
      expect(promptBoxOnScreen(screen("prompt-box-loading-120").map((l) => l.replace("● Loading", `${frame} Loading`)))).toBeUndefined();
    }
  });

  test("an approval dialog, an empty screen and a screen too short for the box are not the input box", () => {
    expect(promptBoxOnScreen(screen("dialog-shell-120"))).toBeUndefined();
    expect(promptBoxOnScreen(Array.from({ length: 30 }, () => ""))).toBeUndefined();
    expect(promptBoxOnScreen(["❯", "────", " Interactive"])).toBeUndefined();
    expect(promptBoxOnScreen(["────", "❯", "────"])).toBeUndefined();
  });
});

describe("a new session's state from its input box (ADR-69)", () => {
  const summary = (changes: { state: string; source: string; confidence: string; reason: string }[]) =>
    changes.map((c) => `${c.state} ${c.source} ${c.confidence} ${c.reason}`);
  const record = (event: "sessionStart" | "agentStop" | "userPromptSubmitted") => ({ event, receivedAt: 0, payload: {}, omitted: [] });

  test("the input box, with or without text, is waiting for you only before the session has a state", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
    expect(summary(session.screen(() => withText))).toEqual(["Input screen medium screen input box before the first prompt"]);

    session.hook(record("userPromptSubmitted"));
    expect(session.screen(() => box)).toEqual([]);
  });

  test("in a session that starts with a prompt the input box is not waiting for you, and the first sessionStart starts work", () => {
    const task = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: true, program: null });

    expect(task.screen(() => box)).toEqual([]);
    expect(task.inPromptBox(() => box)).toBe(false);
    expect(summary(task.hook(record("sessionStart")))).toEqual(["Working hook medium hook sessionStart with a prompt"]);
  });

  test("a prompt the daemon typed before the first hook holds the box back for 5 s", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.promptTyped();
    expect(session.screen(() => box)).toEqual([]);
    expect(session.inPromptBox(() => box)).toBe(false);

    now = RETYPE_AFTER_MS + 1;
    expect(session.inPromptBox(() => box)).toBe(true);
    expect(summary(session.screen(() => box))).toEqual(["Input screen medium screen input box before the first prompt"]);
    // A typed prompt no longer on its way does not make the first sessionStart work: `/resume` may send it.
    expect(summary(session.hook(record("sessionStart")))).toEqual(["Input hook medium hook sessionStart"]);
  });

  test("the sessionStart of a typed prompt on its way starts work, also after a hook that changed nothing", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.hook({ event: "notification", receivedAt: 0, payload: { notification_type: "agent_idle" }, omitted: [] });
    session.promptTyped();

    expect(session.screen(() => withText)).toEqual([]);
    expect(summary(session.hook(record("sessionStart")))).toEqual(["Working hook medium hook sessionStart with a prompt"]);
  });

  test("without a known prompt the first sessionStart is waiting for you: /resume or /clear may send it", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });

    expect(summary(session.hook(record("sessionStart")))).toEqual(["Input hook medium hook sessionStart"]);
    expect(session.inPromptBox(() => box)).toBe(true);
  });

  test("before the first hook the session is in its input box only while the screen shows the empty box now", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });

    expect(session.inPromptBox(() => box)).toBe(true);
    expect(session.inPromptBox(() => screen("dialog-shell-120"))).toBe(false);
    expect(session.inPromptBox(() => withText)).toBe(false);
  });

  test("after the first hook the session is in its input box when the hooks say so and the screen shows the empty box", () => {
    const session = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.promptTyped();
    session.hook(record("sessionStart"));
    expect(session.inPromptBox(() => box)).toBe(false);
    session.hook(record("agentStop"));
    // agentStop comes before Copilot CLI draws the input box again, and text typed in between is lost (ADR-68).
    expect(session.inPromptBox(() => screen("prompt-box-working-120"))).toBe(false);
    expect(session.inPromptBox(() => withText)).toBe(false);
    expect(session.inPromptBox(() => box)).toBe(true);
    // A typed prompt after the first hook changes nothing, and a later sessionStart (`/clear`) leaves the input box.
    session.promptTyped();
    expect(summary(session.hook(record("sessionStart")))).toEqual(["Input hook medium hook sessionStart"]);
    expect(session.inPromptBox(() => box)).toBe(true);
  });
});

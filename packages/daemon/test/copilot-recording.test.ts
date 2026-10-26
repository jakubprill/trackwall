import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { replayCopilotRecording } from "../src/modules/agents/copilot-recording.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";

const fixture = (name: string) => parseAsciicast(readFileSync(join(import.meta.dir, "fixtures", "copilot", name), "utf8"));
const summary = (changes: ReturnType<typeof replayCopilotRecording>) =>
  changes.map((c) => `${c.state} ${c.source} ${c.confidence} ${c.reason}`);

describe("Copilot CLI session state from a recording", () => {
  test("a session with hooks: an approval request lasts over a minute without Stale, and removing the progress bar ends work before the end-of-turn hook", () => {
    const changes = replayCopilotRecording(fixture("approval-session.cast"), { staleAfterMs: 60_000 });

    expect(summary(changes)).toEqual([
      "Input hook medium hook sessionStart",
      "Working hook high hook userPromptSubmitted",
      "Approval hook high hook notification permission_prompt",
      "Working hook high hook postToolUse",
      "Input osc low osc 9;4;0",
      "Input hook high hook agentStop",
      "Done hook high hook sessionEnd user_exit",
    ]);
    expect(changes[2]?.at).toBe("2026-10-23T12:00:04.000Z");
  });

  test("refusing approval with text for the agent: Enter ends waiting for approval at once, not only at the next tool", () => {
    const changes = replayCopilotRecording(fixture("refused-approval-session.cast"), { staleAfterMs: 60_000 });

    expect(summary(changes)).toEqual([
      "Input hook medium hook sessionStart",
      "Working hook high hook userPromptSubmitted",
      "Approval hook high hook notification permission_prompt",
      "Working keyboard medium key enter",
      "Working hook high hook postToolUse",
      "Input hook high hook agentStop",
      "Done hook high hook sessionEnd user_exit",
    ]);
    expect(changes[3]?.at).toBe("2026-10-23T12:00:08.800Z");
  });

  test("Esc at an approval request interrupts the turn without a hook, so the session is waiting for you instead of asking for approval until the end", () => {
    const cast = parseAsciicast(
      [
        '{"version": 2, "width": 80, "height": 24, "timestamp": 0}',
        '[1.0, "m", "{\\"kind\\":\\"hook\\",\\"record\\":{\\"event\\":\\"notification\\",\\"receivedAt\\":1000,\\"payload\\":{\\"notification_type\\":\\"permission_prompt\\"},\\"omitted\\":[]}}"]',
        '[3.0, "m", "{\\"kind\\":\\"key\\",\\"key\\":\\"escape\\"}"]',
        '[3.1, "o", "Operation cancelled by user\\r\\n> "]',
      ].join("\n"),
    );

    expect(summary(replayCopilotRecording(cast, { staleAfterMs: 60_000 }))).toEqual([
      "Approval hook high hook notification permission_prompt",
      "Input keyboard medium key escape",
    ]);
  });

  test("refusing with a digit without Enter: the digit ends waiting for approval, and the interrupted turn message gives waiting for you", () => {
    const cast = parseAsciicast(
      [
        '{"version": 2, "width": 80, "height": 24, "timestamp": 0}',
        '[1.0, "m", "{\\"kind\\":\\"hook\\",\\"record\\":{\\"event\\":\\"notification\\",\\"receivedAt\\":1000,\\"payload\\":{\\"notification_type\\":\\"permission_prompt\\"},\\"omitted\\":[]}}"]',
        '[3.0, "m", "{\\"kind\\":\\"key\\",\\"key\\":\\"choice\\"}"]',
        '[3.2, "o", " ● Operation cancelled by user\\r\\n> "]',
      ].join("\n"),
    );

    expect(summary(replayCopilotRecording(cast, { staleAfterMs: 60_000 }))).toEqual([
      "Approval hook high hook notification permission_prompt",
      "Working keyboard medium key choice",
      "Input screen medium screen operation cancelled",
    ]);
  });

  test("a session without hooks: the state from the OSC 9;4 progress bar, Stale after silence and the exit code at the end", () => {
    const cast = parseAsciicast(
      [
        '{"version": 2, "width": 80, "height": 24, "timestamp": 0}',
        '[1.0, "o", "\\u001b]9;4;3;0\\u0007Thinking"]',
        '[2.0, "o", "."]',
        '[70.0, "o", "."]',
        '[71.0, "o", "\\u001b]9;4;0;0\\u0007> "]',
        '[80.0, "m", "{\\"kind\\":\\"exit\\",\\"code\\":0}"]',
      ].join("\n"),
    );

    expect(summary(replayCopilotRecording(cast, { staleAfterMs: 60_000 }))).toEqual([
      "Working osc high osc 9;4;3",
      "Stale timeout medium no output for 60 s",
      "Working osc high osc 9;4;3",
      "Input osc low osc 9;4;0",
      "Done exit exact exit code 0",
    ]);
    // Stale has the threshold's time (62 s), not that of the next output (70 s), as live.
    expect(replayCopilotRecording(cast, { staleAfterMs: 60_000 })[1]?.at).toBe("1970-01-01T00:01:02.000Z");
  });

  test("the change time is the whole millisecond stored in the recording, also when the seconds have no exact binary representation", () => {
    // 1.005 * 1000 is 1004.9999999999999 in floating point, and the recording stored 1005 ms.
    const cast = parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.005, "o", "\\u001b]9;4;3;0\\u0007"]\n');

    expect(replayCopilotRecording(cast, { staleAfterMs: 60_000 })[0]?.at).toBe("1970-01-01T00:00:01.005Z");
  });

  test("a marker that is not a session record is skipped, and a bad recording line is an error with its number", () => {
    const withManualMarker = parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "m", "it hangs here"]\n');
    expect(replayCopilotRecording(withManualMarker, { staleAfterMs: 60_000 })).toEqual([]);

    expect(() => parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "x", "?"]\n')).toThrow(
      "bad recording line 2",
    );
    expect(() => parseAsciicast('{"version": 2, "width": 80, "height": 24, "timestamp": 0}\n[1.0, "o", \n')).toThrow(
      "bad recording line 2",
    );
  });

  test("the first sessionStart of a task session that starts with a prompt is work, and a later one and one in a plain session is waiting for you", () => {
    const record = { event: "sessionStart" as const, receivedAt: 0, payload: {}, omitted: [] };
    const task = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: true, program: null });
    expect(task.hook(record).map((c) => `${c.state} ${c.reason}`)).toEqual(["Working hook sessionStart with a prompt"]);
    // `/clear` in a task session: the new conversation has no prompt, so the session is waiting for you.
    expect(task.hook(record).map((c) => `${c.state} ${c.reason}`)).toEqual(["Input hook sessionStart"]);
    const plain = new CopilotSessionState({ now: () => 0, staleAfterMs: 60_000, promptOnStart: false, program: null });
    expect(plain.hook(record).map((c) => `${c.state} ${c.reason}`)).toEqual(["Input hook sessionStart"]);
  });

  test("the end of the process after the threshold without a periodic check first gives Stale, like replaying the recording", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.output("\x1b]9;4;3;0\x07");

    now = 61_100;
    expect(session.exit(0).map((c) => `${c.state} ${c.at}`)).toEqual(["Stale 1970-01-01T00:01:00.000Z", "Done 1970-01-01T00:01:01.100Z"]);
  });

  test("the interrupted turn message right after a key ends work without a hook, also when split over two output chunks", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.hook({ event: "notification", receivedAt: 0, payload: { notification_type: "permission_prompt" }, omitted: [] });
    // Enter on “No, and tell Copilot…”, and Copilot CLI ends the turn instead of waiting for text.
    now = 1_000;
    session.key("enter");

    now = 1_300;
    expect(session.output("\u001b[34m●\u001b[m Operation cance")).toEqual([]);
    expect(session.output("lled by user\u001b[30;2H").map((c) => `${c.state} ${c.source} ${c.confidence} ${c.reason}`)).toEqual([
      "Input screen medium screen operation cancelled",
    ]);
  });

  test("the interrupted turn message without a recent key answer is redrawn screen history and does not change the state", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.hook({ event: "notification", receivedAt: 0, payload: { notification_type: "permission_prompt" }, omitted: [] });
    session.key("enter");
    now = 20_000;
    expect(session.output(" ● Operation cancelled by user")).toEqual([]);

    // An Enter that sends a new prompt is not an answer and opens no dialog.
    session.hook({ event: "agentStop", receivedAt: 20_000, payload: {}, omitted: [] });
    session.key("enter");
    session.hook({ event: "userPromptSubmitted", receivedAt: 20_100, payload: {}, omitted: [] });
    now = 21_000;
    expect(session.output(" ● Operation cancelled by user")).toEqual([]);
  });

  test("Esc after the threshold without a periodic check first gives Stale and then waiting for you, as live", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.output("\x1b]9;4;3;0\x07");

    now = 61_100;
    expect(session.key("escape").map((c) => `${c.state} ${c.source} ${c.at}`)).toEqual([
      "Stale timeout 1970-01-01T00:01:00.000Z",
      "Input keyboard 1970-01-01T00:01:01.100Z",
    ]);
  });

  test("output after the threshold without a periodic check gives Stale and a return, like replaying the recording", () => {
    let now = 0;
    const session = new CopilotSessionState({ now: () => now, staleAfterMs: 60_000, promptOnStart: false, program: null });
    session.output("\x1b]9;4;3;0\x07");

    now = 61_100;
    expect(session.output(".").map((c) => `${c.state} ${c.at}`)).toEqual([
      "Stale 1970-01-01T00:01:00.000Z",
      "Working 1970-01-01T00:01:01.100Z",
    ]);
  });
});

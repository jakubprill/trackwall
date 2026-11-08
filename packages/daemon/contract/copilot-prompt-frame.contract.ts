import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { promptBoxLayout } from "@trackwall/protocol";
import { viewer, waitFor } from "../test/support/agents.ts";
import { PROMPT_FRAME_LAYOUT, REFERENCE_COLS, REFERENCE_ROWS } from "../test/support/copilot-reference.ts";
import { screenLines, untilInputBox } from "../test/support/screen-lines.ts";
import { hookRecords, startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// Copilot CLI's framed input box (ADR-220): with its PROMPT_FRAME feature on, which an account may get and
// `COPILOT_PROMPT_FRAME=1` forces, and with a terminal that answered its colour queries, Copilot CLI frames the input
// box in half blocks instead of drawing it between rules with `❯`. The daemon must still see where it may type. On
// Windows ConPTY swallows the colour queries, so there Copilot CLI keeps the ruled box (PROMPT_FRAME_LAYOUT), and the
// test shows that it does, so a ConPTY or Copilot CLI that starts framing it there fails here.

const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
/** The terminals the tests opened, each with the timer that answers its colour queries, closed after the test. */
const terminals: { window: ReturnType<typeof viewer>; answering: ReturnType<typeof setInterval> }[] = [];

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model, {}, { COPILOT_PROMPT_FRAME: "1" });
});

afterEach(async () => {
  for (const { window, answering } of terminals.splice(0)) {
    clearInterval(answering);
    window.attachment.detach();
  }
  const { agents } = daemon.facade;
  for (const session of agents.sessions().sessions) if (session.run.kind === "running") await agents.stop(session.id);
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

afterAll(async () => {
  await daemon.stop();
  await model.close();
});

/** What xterm.js in the session terminal answers each OSC 10 and OSC 11 query with: its foreground and background colour. */
const COLOUR_ANSWERS = [
  { query: "\u001b]10;?", answer: "\u001b]10;rgb:dddd/dddd/dddd\u001b\\" },
  { query: "\u001b]11;?", answer: "\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\" },
];

/**
 * The terminal of session `id` in the reference's size, answering Copilot CLI's colour queries as xterm.js does, once
 * for each query: without the answers Copilot CLI does not frame its box.
 */
function openTerminal(id: string): ReturnType<typeof viewer> {
  const window = viewer(daemon.facade.agents, id);
  window.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
  const answered = new Map(COLOUR_ANSWERS.map(({ query }) => [query, 0]));
  const answering = setInterval(() => {
    const output = window.text();
    for (const { query, answer } of COLOUR_ANSWERS) {
      const asked = output.split(query).length - 1;
      for (let done = answered.get(query) ?? 0; done < asked; done++) window.attachment.input(answer);
      answered.set(query, asked);
    }
  }, 10);
  terminals.push({ window, answering });
  return window;
}

describe("Copilot CLI's framed input box with the real Copilot CLI (ADR-220)", () => {
  test("a new supervisor waits for you in the framed input box before its first prompt, between rules on Windows", async () => {
    const { agents } = daemon.facade;
    const supervisor = await agents.startSupervisor("new", "terminal");
    const window = openTerminal(supervisor.id);

    const ready = await waitFor(agents, supervisor.id, (s) => s.state !== null, "the framed input box of a new supervisor", SESSION_MS);
    expect(promptBoxLayout(await screenLines(window))).toBe(PROMPT_FRAME_LAYOUT);
    expect(ready.state).toMatchObject({ state: "Input", source: "screen", reason: "screen input box before the first prompt" });
  });

  test("a review sent once a task's turn has ended is typed into the framed input box (ruled on Windows) and reaches the agent", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Added the test." });
    const task = await agents.createTask("shop", "add a login test");
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");
    const window = openTerminal(session.id);
    await waitFor(agents, session.id, (s) => s.state?.reason === "hook agentStop", "end of turn", SESSION_MS);
    await untilInputBox(window, "empty");
    expect(promptBoxLayout(await screenLines(window))).toBe(PROMPT_FRAME_LAYOUT);

    model.reply({ text: "Renamed it." });
    const review = { path: "README.md", side: "new" as const, line: 1, code: "# shop", text: "Call it login-test" };
    expect(agents.sendReview(task.id, [review]).delivery).toBe("typed");
    await waitFor(
      agents,
      session.id,
      () => hookRecords(daemon.home, session.id).filter((r) => r.event === "agentStop").length >= 2,
      "the review turn's end",
      SESSION_MS,
    );
    expect(model.requests().at(-1)?.lastUserText).toContain("The user sent a review of your changes in Trackwall");
  });
});

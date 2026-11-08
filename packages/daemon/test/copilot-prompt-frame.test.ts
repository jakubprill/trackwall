import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentsApi, promptBoxLayout } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { PROMPT_FRAME_LAYOUT } from "./support/copilot-reference.ts";
import { screenLines, untilInputBox } from "./support/screen-lines.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// Copilot CLI 1.0.107 frames its input box in half blocks instead of rules and `❯` when its PROMPT_FRAME feature is on
// (ADR-220); the fake draws it with COPILOT_PROMPT_FRAME=1 (on Windows the ruled box, as the real one behind ConPTY), and
// the daemon must still see where it may type.

const TOKEN = "f".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    ...ONE_REPO,
    copilot: { command: FAKE_COPILOT.command, env: () => ({ ...process.env, COPILOT_PROMPT_FRAME: "1" }) },
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

/** The fake's prompt line for a typed prompt: "Thinking about: <prompt>". */
const TYPED_REVIEW = "Thinking about: The user sent a review of your changes in Trackwall: call get_review_comments";

describe.skipIf(process.versions.bun === undefined)("Copilot CLI's framed input box (real PTY and git, fake Copilot CLI)", () => {
  test("a new session waits for you in the framed input box before its first prompt, between rules on Windows", async () => {
    const started = await daemon.facade.agents.start("shop");
    const window = viewer(daemon.facade.agents, started.id);
    const ready = await waitFor(daemon.facade.agents, started.id, (s) => s.state !== null, "the first state");

    expect(promptBoxLayout(await screenLines(window))).toBe(PROMPT_FRAME_LAYOUT);
    expect(ready.state).toMatchObject({ state: "Input", source: "screen", reason: "screen input box before the first prompt" });
    window.attachment.detach();
    await daemon.facade.agents.stop(started.id);
  }, 30_000);

  test("a review sent once the task's turn has ended is typed into the framed input box (ruled on Windows) and reaches the agent", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe how to run shop", approvals: "ask" });
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");
    const window = viewer(daemon.facade.agents, session.id);
    // The fake ends a turn after a line and an approval.
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Working", "the task prompt's turn");
    window.attachment.input("start\r");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the approval request");
    window.attachment.input("1");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.reason === "hook agentStop", "the end of the turn");
    await untilInputBox(window, "empty");
    expect(promptBoxLayout(await screenLines(window))).toBe(PROMPT_FRAME_LAYOUT);

    const review = { path: "README.md", side: "new" as const, line: 1, code: "# shop", text: "Name the port" };
    expect(await daemon.post(agentsApi.sendReview, { task: task.id, comments: [review] })).toEqual({ delivery: "typed", unread: 1 });
    await waitFor(daemon.facade.agents, session.id, () => window.unwrappedText().includes(TYPED_REVIEW), "the typed review prompt");

    window.attachment.input("1");
    window.attachment.detach();
    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TaskRounds, taskRoundsApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { gitIn } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] });
  // Round commits carry the user's own identity, which git takes from the repo's config here.
  gitIn(join(daemon.projects, "shop"), "config", "user.name", "Repo User");
  gitIn(join(daemon.projects, "shop"), "config", "user.email", "user@example.com");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
const rounds = (task: string) => daemon.post(taskRoundsApi.rounds, { task });

/** Asks for the rounds until `check` holds. */
async function roundsWhen(task: string, check: (r: TaskRounds) => boolean, what: string): Promise<TaskRounds> {
  const until = Date.now() + 20_000;
  for (;;) {
    const now = await rounds(task);
    if (check(now)) return now;
    if (Date.now() > until) throw new Error(`gave up waiting for: ${what}; last ${JSON.stringify(now)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A task whose first turn (the user's line; the fake asks for one approval) is under way, with its session and terminal. */
async function taskInFirstTurn(prompt: string) {
  const task = await daemon.facade.agents.createTask("shop", prompt);
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
  if (!session) throw new Error(`task ${task.id} has no session`);
  const terminal = viewer(daemon.facade.agents, session.id);
  terminal.attachment.input("start\r");
  await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the first turn's approval");
  // The turn's start is read from the worktree in the background, after its hook; the rounds are listed after it, so
  // once they come back the worktree as the turn found it is known. A test that wrote a file before (Windows runs git
  // slowly) would have the agent's own change read as one from outside.
  expect(await rounds(task.id)).toEqual({ rounds: [], undo: null, blocked: null, problem: null });
  return { task, session: session.id, terminal };
}

describe.skipIf(process.versions.bun === undefined)("task rounds (ADR-168; real PTY and git, fake Copilot CLI)", () => {
  test("a turn that changed the worktree is a round with a commit and a diff of its own, and Undo round takes it back and tells the agent", async () => {
    const { task, session, terminal } = await taskInFirstTurn("Add a cart");

    // The agent writes a file and leaves it uncommitted; the turn ends with the approval.
    writeFileSync(join(task.worktree, "cart.ts"), "export const cart = [];\n");
    terminal.attachment.input("1");
    const after = await roundsWhen(task.id, (r) => r.rounds.length === 1, "round 1");
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Input", "the end of the turn");

    const roundCommit = head(task.worktree);
    expect(gitIn(task.worktree, "log", "-1", "--format=%s|%an").trim()).toBe("WIP round 1|Repo User");
    expect(gitIn(task.worktree, "status", "--porcelain")).toBe("");
    expect(after.rounds).toEqual([
      { number: 1, from: task.base, to: roundCommit, endedAt: expect.any(String), roundCommit, outside: false, undoneAt: null },
    ]);
    const changes = await daemon.post(taskRoundsApi.roundChanges, { task: task.id, round: 1 });
    expect(changes.files.map((f) => [f.path, f.change])).toEqual([["cart.ts", "added"]]);
    expect(await rounds(task.id)).toMatchObject({ undo: 1, blocked: null });

    // A change by hand after the round ended would be lost with it: the undo is refused and says why.
    writeFileSync(join(task.worktree, "README.md"), "# shop, by hand\n");
    const touched = await rounds(task.id);
    expect(touched.blocked).toBe(
      "The worktree changed since round 1 ended (by hand or by the agent), so Trackwall does not undo it: nothing would be left of those changes.",
    );
    await expect(daemon.post(taskRoundsApi.undoRound, { task: task.id, round: 1 })).rejects.toThrow(
      "The worktree changed since round 1 ended",
    );
    gitIn(task.worktree, "checkout", "--", "README.md");

    const undone = await daemon.post(taskRoundsApi.undoRound, { task: task.id, round: 1 });
    expect(undone).toMatchObject({ undo: null, blocked: null });
    expect(undone.rounds[0]?.undoneAt).toEqual(expect.any(String));
    expect(head(task.worktree)).toBe(task.base);
    expect(existsSync(join(task.worktree, "cart.ts"))).toBe(false);
    // The agent waits for input, so it is told at once.
    await waitFor(
      daemon.facade.agents,
      session,
      () => terminal.unwrappedText().includes("Thinking about: The user undid your last round of changes in Trackwall"),
      "the typed undo prompt",
    );
    // An undone round is not undone twice, and an unknown one has no diff.
    await expect(daemon.post(taskRoundsApi.undoRound, { task: task.id, round: 1 })).rejects.toThrow(
      "round 1 is not the newest round that stands",
    );
    await expect(daemon.post(taskRoundsApi.roundChanges, { task: task.id, round: 7 })).rejects.toThrow("keeps no round 7");
  }, 60_000);

  test("a turn that started on a change made by hand is a round that is not undone, and the agent's own commit makes no round commit", async () => {
    const { task, session, terminal } = await taskInFirstTurn("Add a price");
    // The agent commits its work itself in the first turn.
    writeFileSync(join(task.worktree, "price.ts"), "export const price = 1;\n");
    gitIn(task.worktree, "add", "price.ts");
    gitIn(task.worktree, "commit", "-qm", "Add a price");
    terminal.attachment.input("1");
    const first = await roundsWhen(task.id, (r) => r.rounds.length === 1, "round 1");
    expect(first.rounds[0]).toMatchObject({ number: 1, from: task.base, to: head(task.worktree), roundCommit: null, outside: false });
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Input", "the end of the first turn");

    // A hand edit between the turns, then the user starts the next turn, once the input box is back (keys typed before
    // it are lost, as in Copilot CLI).
    writeFileSync(join(task.worktree, "README.md"), "# shop, by hand\n");
    await new Promise((r) => setTimeout(r, 1000));
    terminal.attachment.input("go on\r");
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the second turn's approval");
    writeFileSync(join(task.worktree, "tax.ts"), "export const tax = 0;\n");
    terminal.attachment.input("1");
    const second = await roundsWhen(task.id, (r) => r.rounds.length === 2, "round 2");

    expect(second.rounds[0]).toMatchObject({ number: 2, outside: true, roundCommit: head(task.worktree) });
    expect(second.undo).toBe(2);
    expect(second.blocked).toBe(
      "Round 2 started with changes made outside the agent's rounds (by hand, or before Trackwall saw the turn start): undoing it would drop them too.",
    );

    // While the agent is in a turn again, here waiting for an approval, nothing is undone.
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Input", "the end of the second turn");
    await new Promise((r) => setTimeout(r, 1000));
    terminal.attachment.input("once more\r");
    await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the third turn's approval");
    expect((await rounds(task.id)).blocked).toBe("The agent is in the middle of a turn: undo once it waits for you.");
  }, 60_000);
});

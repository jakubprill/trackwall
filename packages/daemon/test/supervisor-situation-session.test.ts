import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { agentsApi, type ConversationEntry } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "s".repeat(43);
const daemons: Awaited<ReturnType<typeof startSessionApi>>[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
}, 30_000);

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `test` exits with code 1, so a verification fails. */
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "test" }], exits: { test: 1 } });

async function startDaemon() {
  const daemon = await startSessionApi(TOKEN, { repos: { shop: { "fake-mise.json": MISE_CONFIG } }, miseCommand: FAKE_MISE });
  daemons.push(daemon);
  return daemon;
}

describe.skipIf(process.versions.bun === undefined)("the supervisor's situation with each prompt (fake Copilot CLI, ADR-148)", () => {
  test("in a terminal, the user's message to the supervisor comes with the situation, which names the main session the user started", async () => {
    const daemon = await startDaemon();
    const main = await daemon.post(agentsApi.start, { repo: "shop" });
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "terminal" });
    const window = viewer(daemon.facade.agents, supervisor.id);
    await waitFor(daemon.facade.agents, supervisor.id, () => window.text().includes("❯"), "the supervisor's input box");

    window.attachment.input("what is going on?\r");

    await waitFor(daemon.facade.agents, supervisor.id, () => window.unwrappedText().includes("Prompt context:"), "the prompt's context");
    const screen = window.unwrappedText();
    expect(screen).toContain("Prompt context: Trackwall's work under way as this prompt came");
    expect(screen).toContain(`- a main session in shop (session ${main.id}), started by the user:`);
  });

  test("a task's failed verification reaches the supervisor with its next prompt (ADR-156)", async () => {
    const daemon = await startDaemon();
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a signup test", approvals: "ask" });
    const verdict = await daemon.facade.verifications.verify(task.id, undefined, 30_000, new AbortController().signal);
    expect(verdict.state).toBe("failed");
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "terminal" });
    const window = viewer(daemon.facade.agents, supervisor.id);
    await waitFor(daemon.facade.agents, supervisor.id, () => window.text().includes("❯"), "the supervisor's input box");

    window.attachment.input("is the signup test done?\r");

    await waitFor(daemon.facade.agents, supervisor.id, () => window.unwrappedText().includes("Prompt context:"), "the prompt's context");
    expect(window.unwrappedText()).toMatch(
      new RegExp(`- task ${task.id} "add a signup test" in shop, started by the user: [^;]+; last verification failed`),
    );
  });

  test("in the conversation view, the prompt's hook gives the situation with the user's task, and the conversation shows only the message", async () => {
    const daemon = await startDaemon();
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add a signup test", approvals: "ask" });
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "conversation" });
    await waitFor(daemon.facade.agents, supervisor.id, (s) => s.state?.state === "Input", "the supervisor ready");

    await daemon.post(agentsApi.say, { session: supervisor.id, text: "what is going on?" });

    const asking = await waitFor(daemon.facade.agents, supervisor.id, (s) => s.state?.state === "Approval", "the turn's approval");
    await daemon.post(agentsApi.answerDialog, { session: supervisor.id, dialog: asking.dialog?.id ?? "", answer: "1" });
    await waitFor(daemon.facade.agents, supervisor.id, (s) => s.state?.state === "Input", "the end of the turn");
    // A view attached now gets the whole conversation at once.
    let entries: ConversationEntry[] = [];
    daemon.facade.agents
      .attachConversation(supervisor.id, {
        send: (message) => {
          entries = message.entries;
        },
        closed: () => {},
      })
      .detach();
    expect(entries.filter((e) => e.kind === "user")).toEqual([{ id: expect.any(String), kind: "user", text: "what is going on?" }]);
    const answer = entries.findLast((e) => e.kind === "agent");
    expect(answer?.kind === "agent" && answer.text).toContain("Prompt context: Trackwall's work under way as this prompt came");
    expect(answer?.kind === "agent" && answer.text).toContain(`- task ${task.id} "add a signup test" in shop, started by the user:`);
  });
});

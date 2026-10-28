import { afterEach, describe, expect, test } from "bun:test";
import {
  agentsApi,
  CONVERSATION_SUBPROTOCOL,
  type ConversationEntry,
  ConversationServerMessage,
  dayStartApi,
  PTY_CLOSE_NOT_FOUND,
  PTY_SUBPROTOCOL,
  type Session,
} from "@trackwall/protocol";
import WebSocket from "ws";
import { FAKE_ACP_COMMAND } from "./fixtures/fake-copilot-acp.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "c".repeat(43);
const daemons: Awaited<ReturnType<typeof startSessionApi>>[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
}, 30_000);

async function startDaemon(restartOf?: { home: string; projects: string }) {
  const daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"], restartOf });
  daemons.push(daemon);
  return daemon;
}

type Daemon = Awaited<ReturnType<typeof startSessionApi>>;

/** A conversation view: the entries as the socket's frames build them, keyed and in order. */
function conversation(daemon: Daemon, session: string, protocols = [CONVERSATION_SUBPROTOCOL, `bearer.${TOKEN}`]) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws/conversation/${session}`, protocols);
  let entries: ConversationEntry[] = [];
  ws.on("message", (data: Buffer) => {
    const message = ConversationServerMessage.parse(JSON.parse(data.toString("utf8")));
    if (message.reset) entries = [];
    for (const entry of message.entries) {
      const at = entries.findIndex((e) => e.id === entry.id);
      if (at >= 0) entries[at] = entry;
      else entries.push(entry);
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, opened, closed, entries: () => entries };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const inState = (daemon: Daemon, id: string, state: string) => waitFor(daemon.facade.agents, id, (s) => s.state?.state === state, state);

describe.skipIf(process.versions.bun === undefined)("the supervisor in the conversation view (fake Copilot CLI over ACP, ADR-107)", () => {
  test("a message starts a turn, its approval is answered from the API, and the conversation socket gets the conversation", async () => {
    const daemon = await startDaemon();
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "conversation" });
    expect(supervisor).toMatchObject({ repo: null, supervisor: true, view: "conversation", run: { kind: "running" } });
    await inState(daemon, supervisor.id, "Input");
    const view = conversation(daemon, supervisor.id);
    await view.opened;

    await daemon.post(agentsApi.say, { session: supervisor.id, text: "  Check the build  " });
    const asking = await inState(daemon, supervisor.id, "Approval");

    expect(asking.dialog).toMatchObject({
      kind: "approval",
      title: "Make a file",
      detail: [`$ ${FAKE_ACP_COMMAND}`],
      question: "Do you want to allow this?",
      options: [
        { key: "1", label: "Allow once" },
        { key: "2", label: "Always allow" },
        { key: "3", label: "Deny" },
      ],
    });
    const dialog = asking.dialog?.id ?? "";
    await daemon.post(agentsApi.answerDialog, { session: supervisor.id, dialog, answer: "1" });
    await inState(daemon, supervisor.id, "Input");
    await until(() => view.entries().some((e) => e.kind === "agent" && e.text.includes("Argument:")), "the answer");
    const [said, tool, answer] = view.entries();
    expect(said).toMatchObject({ kind: "user", text: "Check the build" });
    expect(tool).toMatchObject({ kind: "tool", title: "Make a file", tool: "execute", status: "completed", detail: ["made-by-agent", ""] });
    expect(answer).toMatchObject({ kind: "agent" });
    expect(answer?.kind === "agent" && answer.text).toContain("Thinking about: Check the build");
    // Copilot CLI over ACP gets the same MCP server and instructions as in a terminal, and no session plugin.
    expect(answer?.kind === "agent" && answer.text).toContain("MCP: trackwall");
    expect(answer?.kind === "agent" && answer.text).toContain("Instructions: trackwall.instructions.md");
    await until(() => daemon.facade.agents.sessions().lastSupervisor === supervisor.id, "the supervisor's conversation");

    view.ws.close();
    await daemon.post(agentsApi.stop, { session: supervisor.id });
  }, 60_000);

  test("a refused approval fails the tool, and Stop during an approval ends the turn without running it", async () => {
    const daemon = await startDaemon();
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "conversation" });
    await inState(daemon, supervisor.id, "Input");
    const view = conversation(daemon, supervisor.id);
    await view.opened;

    await daemon.post(agentsApi.say, { session: supervisor.id, text: "first" });
    const first = await inState(daemon, supervisor.id, "Approval");
    await daemon.post(agentsApi.answerDialog, { session: supervisor.id, dialog: first.dialog?.id ?? "", answer: "3" });
    await inState(daemon, supervisor.id, "Input");
    await until(() => view.entries().some((e) => e.kind === "tool" && e.status === "failed"), "the refused tool");
    expect(view.entries().find((e) => e.kind === "tool")).toMatchObject({ detail: ["The user rejected this tool call."] });

    await daemon.post(agentsApi.say, { session: supervisor.id, text: "second" });
    await inState(daemon, supervisor.id, "Approval");
    const stopped = await daemon.post(agentsApi.interrupt, { session: supervisor.id });

    expect(stopped.dialog).toBeNull();
    const ended = await inState(daemon, supervisor.id, "Input");
    expect(ended.state?.reason).toBe("stop cancelled");
    expect(
      view
        .entries()
        .filter((e) => e.kind === "tool")
        .map((e) => e.kind === "tool" && e.status),
    ).toEqual(["failed", "pending"]);

    view.ws.close();
    await daemon.post(agentsApi.stop, { session: supervisor.id });
  }, 60_000);

  test("a message the user writes during a turn goes as the next prompt once the turn ends", async () => {
    const daemon = await startDaemon();
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "conversation" });
    await inState(daemon, supervisor.id, "Input");
    await daemon.post(agentsApi.say, { session: supervisor.id, text: "first" });
    const asking = await inState(daemon, supervisor.id, "Approval");

    await daemon.post(agentsApi.say, { session: supervisor.id, text: "then this" });
    await daemon.post(agentsApi.answerDialog, { session: supervisor.id, dialog: asking.dialog?.id ?? "", answer: "1" });

    const next = await waitFor(
      daemon.facade.agents,
      supervisor.id,
      (s) => s.dialog !== null && s.dialog.id !== asking.dialog?.id,
      "the next turn",
    );
    expect(next.state?.state).toBe("Approval");
    const view = conversation(daemon, supervisor.id);
    await view.opened;
    await until(() => view.entries().length > 0, "the conversation");
    expect(
      view
        .entries()
        .filter((e) => e.kind === "user")
        .map((e) => e.kind === "user" && e.text),
    ).toEqual(["first", "then this"]);

    view.ws.close();
    await daemon.post(agentsApi.stop, { session: supervisor.id });
  }, 60_000);

  test("the conversation goes on in the conversation view after a stop, and in a terminal under Copilot CLI's id of it", async () => {
    const daemon = await startDaemon();
    const { agents } = daemon.facade;
    const first = await agents.startSupervisor("new", "conversation");
    await inState(daemon, first.id, "Input");
    agents.say(first.id, "remember this");
    const asking = await inState(daemon, first.id, "Approval");
    agents.answerDialog(first.id, asking.dialog?.id ?? "", "1");
    await inState(daemon, first.id, "Input");
    await until(() => agents.sessions().lastSupervisor === first.id, "the supervisor's conversation");
    await agents.stop(first.id);

    const loaded = await agents.startSupervisor("last", "conversation");
    expect(loaded).toMatchObject({ id: first.id, view: "conversation" });
    await inState(daemon, first.id, "Input");
    const view = conversation(daemon, first.id);
    await view.opened;
    await until(() => view.entries().some((e) => e.kind === "agent"), "the loaded conversation");
    expect(view.entries()[0]).toMatchObject({ kind: "user", text: "remember this" });
    view.ws.close();
    await agents.stop(first.id);

    const inTerminal = await agents.startSupervisor("last", "terminal");
    expect(inTerminal).toMatchObject({ id: first.id, view: "terminal" });
    const window = viewer(agents, first.id);
    await until(() => window.text().includes("Argument: --resume="), "the terminal's arguments");
    expect(window.text()).not.toContain(`--resume=${first.id}`);
    window.attachment.detach();
    await agents.stop(first.id);
  }, 60_000);

  test("a supervisor in the conversation view that ran when the daemon stopped goes on in the next daemon", async () => {
    const before = await startDaemon();
    const supervisor = await before.facade.agents.startSupervisor("new", "conversation");
    await inState(before, supervisor.id, "Input");
    before.facade.agents.say(supervisor.id, "keep going");
    await inState(before, supervisor.id, "Approval");
    await until(() => before.facade.agents.sessions().lastSupervisor === supervisor.id, "the supervisor's conversation");
    daemons.splice(daemons.indexOf(before), 1);
    await before.stop();

    const after = await startDaemon({ home: before.home, projects: before.projects });

    const resumed: Session = await waitFor(after.facade.agents, supervisor.id, (s) => s.state?.state === "Input", "the resumed supervisor");
    expect(resumed).toMatchObject({ supervisor: true, view: "conversation" });
    await after.post(agentsApi.stop, { session: supervisor.id });
  }, 60_000);

  test("the day start starts its supervisor in the view it is given", async () => {
    const daemon = await startDaemon();
    await daemon.post(dayStartApi.start, { view: "conversation" });
    await until(() => daemon.facade.agents.sessions().sessions.some((s) => s.supervisor), "the day start's supervisor");
    const supervisor = daemon.facade.agents.sessions().sessions.find((s) => s.supervisor);
    expect(supervisor?.view).toBe("conversation");
    // The day start's first message is the first prompt: the turn asks for its approval.
    await inState(daemon, supervisor?.id ?? "", "Approval");
    await daemon.post(agentsApi.stop, { session: supervisor?.id ?? "" });
  }, 60_000);

  test("the conversation socket needs the token, and a session in the conversation view has no terminal", async () => {
    const daemon = await startDaemon();
    const supervisor = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "conversation" });

    await expect(conversation(daemon, supervisor.id, [CONVERSATION_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    const terminal = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws/pty/${supervisor.id}`, [PTY_SUBPROTOCOL, `bearer.${TOKEN}`]);
    expect(await new Promise<number>((resolve) => terminal.once("close", resolve))).not.toBe(1000);
    const unknown = conversation(daemon, "9b2f0c1e-1d2c-4b3a-8f9e-0a1b2c3d4e5f");
    expect(await unknown.closed).toBe(PTY_CLOSE_NOT_FOUND);
    await expect(daemon.post(agentsApi.say, { session: supervisor.id, text: "   " })).rejects.toThrow();

    const view = conversation(daemon, supervisor.id);
    await view.opened;
    await daemon.post(agentsApi.stop, { session: supervisor.id });
    await daemon.post(agentsApi.dismiss, { session: supervisor.id });
    expect(await view.closed).toBe(PTY_CLOSE_NOT_FOUND);
  }, 60_000);
});

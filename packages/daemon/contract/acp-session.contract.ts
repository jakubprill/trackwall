import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConversationEntry, MCP_SERVER_NAME, mcpTools, type Session } from "@trackwall/protocol";
import { viewer, waitFor } from "../test/support/agents.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ModelRequest, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// The contract of the conversation view with the real Copilot CLI (ADR-107, for tasks ADR-137): `copilot --acp` as the
// daemon starts it, with the session's MCP server, instructions and tool permissions, against the scripted model. The fake's ACP mode
// (`test/fixtures/fake-copilot-acp.ts`) sends the same messages; a failure here means it is out of date too.

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
let workspaceFile: string;

/** Whether the supervisor may change code (ADR-78), written into the daemon's workspace file. */
function setChangesCode(changesCode: boolean): void {
  const rest = readFileSync(workspaceFile, "utf8").replace(/supervisor:\n {2}changesCode: (true|false)\n/, "");
  writeFileSync(workspaceFile, `${rest}supervisor:\n  changesCode: ${changesCode}\n`);
}

/** How long a session may take to start and to finish a turn: a cold ~170 MB binary that Windows Defender scans. */
const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model);
  // The supervisor may change code here, so its shell asks for an approval instead of being refused (ADR-78).
  workspaceFile = join(daemon.home, "workspace.yaml");
  setChangesCode(true);
});

// A failed test leaves no supervisor running for the next one, which would get it instead of a new one.
afterEach(async () => {
  const { agents } = daemon.facade;
  for (const session of agents.sessions().sessions) if (session.run.kind === "running") await agents.stop(session.id);
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

afterAll(async () => {
  await daemon.stop();
  await model.close();
});

/** The shell tool Copilot CLI gives the model: `powershell` on Windows, `bash` elsewhere. */
function shellCall(request: ModelRequest, command: { bash: string; powershell: string }) {
  const tool = request.tools.includes("powershell") ? "powershell" : "bash";
  return { tool, arguments: { command: command[tool], description: "Create a file" } };
}

const inState = (id: string, state: string) => waitFor(daemon.facade.agents, id, (s) => s.state?.state === state, state, SESSION_MS);

/** The conversation as the conversation socket sends it. */
function conversationOf(id: string) {
  let entries: ConversationEntry[] = [];
  const window = daemon.facade.agents.attachConversation(id, {
    send: (message) => {
      if (message.reset) entries = [];
      for (const entry of message.entries) {
        const at = entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
    },
    closed: () => {},
  });
  // The daemon sends what it has before each state change, but an update Copilot CLI sends after a prompt's result
  // (none seen so far) would come later; waiting for it keeps the tests about the content, not that order.
  const until = async (check: (entries: ConversationEntry[]) => boolean, what: string) => {
    const deadline = Date.now() + 5_000;
    while (!check(entries)) {
      if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}: ${JSON.stringify(entries)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { entries: () => entries, until, detach: () => window.detach() };
}

async function startSupervisor(): Promise<Session> {
  const supervisor = await daemon.facade.agents.startSupervisor("new", "conversation");
  expect(supervisor).toMatchObject({ supervisor: true, view: "conversation" });
  await inState(supervisor.id, "Input");
  return supervisor;
}

describe("the supervisor in the conversation view with the real Copilot CLI", () => {
  test("the first prompt reaches the model with Trackwall's MCP tools and the supervisor's instructions, and a shell command waits for the approval the daemon answers", async () => {
    const { agents } = daemon.facade;
    const supervisor = await startSupervisor();
    const view = conversationOf(supervisor.id);
    model.reply((request) => shellCall(request, { bash: "touch made-by-acp.txt", powershell: "New-Item made-by-acp.txt" }), {
      text: "Made **one** file.",
    });

    agents.say(supervisor.id, "make a file");
    const asking = await inState(supervisor.id, "Approval");

    expect(asking.dialog).toMatchObject({ kind: "approval", question: "Do you want to allow this?" });
    expect(asking.dialog?.kind === "approval" && asking.dialog.detail.join("\n")).toMatch(/^\$ (touch|New-Item) made-by-acp\.txt$/m);
    expect(asking.dialog?.kind === "approval" && asking.dialog.options.map((o) => o.label)).toEqual(["Allow once", "Always allow", "Deny"]);
    agents.answerDialog(supervisor.id, asking.dialog?.id ?? "", "1");
    const done = await inState(supervisor.id, "Input");

    expect(done.state?.reason).toBe("stop end_turn");
    expect(existsSync(join(daemon.projects, "made-by-acp.txt"))).toBe(true);
    const [first] = model.requests().slice(-2);
    // Copilot CLI puts the date and time before the user's text, and the situation from the prompt's hook after it (ADR-148).
    expect(first?.lastUserText).toContain("make a file\n\n<system_reminder>\nTrackwall's work under way as this prompt came");
    expect(first?.tools).toContain(`${MCP_SERVER_NAME}-${mcpTools.listRepos.name}`);
    expect(first?.system).toContain("You are the supervisor");
    await view.until((entries) => entries.at(-1)?.kind === "agent", "the answer");
    const entries = view.entries();
    expect(entries[0]).toEqual({ id: expect.any(String), kind: "user", text: "make a file" });
    expect(entries.find((e) => e.kind === "tool")).toMatchObject({ tool: "execute", status: "completed" });
    expect(entries.at(-1)).toMatchObject({ kind: "agent", text: "Made **one** file." });
    view.detach();
    await agents.stop(supervisor.id);
  });

  test("a refused approval does not run the command, and Stop during an approval ends the turn as cancelled", async () => {
    const { agents } = daemon.facade;
    const supervisor = await startSupervisor();
    const view = conversationOf(supervisor.id);
    // A refused tool ends the turn: Copilot CLI does not ask the model again.
    model.reply((request) => shellCall(request, { bash: "touch refused.txt", powershell: "New-Item refused.txt" }));
    agents.say(supervisor.id, "make the refused file");
    const refusing = await inState(supervisor.id, "Approval");
    agents.answerDialog(supervisor.id, refusing.dialog?.id ?? "", "3");
    await inState(supervisor.id, "Input");

    expect(existsSync(join(daemon.projects, "refused.txt"))).toBe(false);
    await view.until((entries) => entries.some((e) => e.kind === "tool" && e.status === "failed"), "the refused tool");
    expect(view.entries().find((e) => e.kind === "tool")).toMatchObject({
      status: "failed",
      detail: ["The user rejected this tool call."],
    });

    model.reply((request) => shellCall(request, { bash: "touch stopped.txt", powershell: "New-Item stopped.txt" }));
    agents.say(supervisor.id, "make the stopped file");
    await inState(supervisor.id, "Approval");
    agents.interrupt(supervisor.id);
    const stopped = await inState(supervisor.id, "Input");

    expect(stopped.state?.reason).toBe("stop cancelled");
    expect(existsSync(join(daemon.projects, "stopped.txt"))).toBe(false);
    view.detach();
    await agents.stop(supervisor.id);
  });

  test("a supervisor that may not change code has its shell refused without an approval (ADR-78)", async () => {
    const { agents } = daemon.facade;
    setChangesCode(false);
    try {
      const supervisor = await startSupervisor();
      model.reply((request) => shellCall(request, { bash: "touch by-shell.txt", powershell: "New-Item by-shell.txt" }), {
        text: "It was refused.",
      });

      agents.say(supervisor.id, "make a file");
      await waitFor(agents, supervisor.id, (s) => s.state?.reason === "stop end_turn", "end of turn", SESSION_MS);

      const [, second] = model.requests().slice(-2);
      expect(second?.toolResults.join("\n")).toContain("denied");
      expect(existsSync(join(daemon.projects, "by-shell.txt"))).toBe(false);
      expect(agents.session(supervisor.id).dialog).toBeNull();
      await agents.stop(supervisor.id);
    } finally {
      setChangesCode(true);
    }
  });

  test("Resume loads the conversation into the conversation view, and a terminal goes on with it under Copilot CLI's id", async () => {
    const { agents } = daemon.facade;
    const supervisor = await startSupervisor();
    model.reply({ text: "I will remember." });
    agents.say(supervisor.id, "remember the word kiwi");
    await waitFor(agents, supervisor.id, (s) => s.state?.reason === "stop end_turn", "end of turn", SESSION_MS);
    await waitFor(agents, supervisor.id, () => agents.sessions().lastSupervisor === supervisor.id, "the conversation", SESSION_MS);
    await agents.stop(supervisor.id);

    await agents.startSupervisor("last", "conversation");
    await inState(supervisor.id, "Input");
    const view = conversationOf(supervisor.id);

    expect(view.entries().map((e) => (e.kind === "tool" ? e.kind : `${e.kind}: ${e.text}`))).toEqual([
      "user: remember the word kiwi",
      "agent: I will remember.",
    ]);
    view.detach();
    await agents.stop(supervisor.id);

    const inTerminal = await agents.startSupervisor("last", "terminal");
    expect(inTerminal.view).toBe("terminal");
    const window = viewer(agents, supervisor.id);
    await waitFor(
      agents,
      supervisor.id,
      () => window.unwrappedText().includes("remember the word kiwi"),
      "the conversation in the terminal",
      SESSION_MS,
    );
    window.attachment.detach();
    await agents.stop(supervisor.id);
  });
});

/** A model other than the scripted model's default (`COPILOT_MODEL`), which only a task's `--model` asks for (ADR-98). */
const TASK_MODEL = "trackwall-task-model";

/** The task's only session. */
function taskSessionOf(task: string): string {
  const [session, ...more] = daemon.facade.agents.sessions().sessions.filter((s) => s.task === task);
  if (session === undefined || more.length > 0) throw new Error(`task ${task} does not have exactly one session`);
  return session.id;
}

const endOfTurn = (id: string) => waitFor(daemon.facade.agents, id, (s) => s.state?.reason === "stop end_turn", "end of turn", SESSION_MS);

describe("a task in the conversation view with the real Copilot CLI (ADR-137)", () => {
  test("the prompt is the first message in the task worktree on the task's model, and with auto approvals a shell command runs without asking", async () => {
    const { agents } = daemon.facade;
    model.reply((request) => shellCall(request, { bash: "touch made-by-task.txt", powershell: "New-Item made-by-task.txt" }), {
      text: "Made the file.",
    });

    const task = await agents.createTask("shop", "make a file", { view: "conversation", approvals: "auto", model: TASK_MODEL });
    const session = taskSessionOf(task.id);
    await endOfTurn(session);

    expect(agents.session(session)).toMatchObject({ view: "conversation", dialog: null });
    expect(existsSync(join(task.worktree, "made-by-task.txt"))).toBe(true);
    const [first] = model.requests().slice(-2);
    expect(first?.lastUserText).toEndWith("make a file");
    expect(first).toMatchObject({ model: TASK_MODEL });
    // Copilot CLI names its working directory by the real path (macOS: /private/var/… for the temporary /var/…).
    expect(first?.system).toContain(realpathSync.native(task.worktree));
    await agents.stop(session);
  });

  test("Resume loads the task's conversation on the task's model, and a review goes as the next prompt", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Starting on the login test." });
    const task = await agents.createTask("shop", "add a login test", { view: "conversation", model: TASK_MODEL });
    const first = taskSessionOf(task.id);
    await endOfTurn(first);
    await agents.stop(first);

    await agents.resumeTask(task.id);
    const resumed = taskSessionOf(task.id);
    await inState(resumed, "Input");
    const view = conversationOf(resumed);
    expect(view.entries().map((e) => (e.kind === "tool" ? e.kind : `${e.kind}: ${e.text}`))).toEqual([
      "user: add a login test",
      "agent: Starting on the login test.",
    ]);
    view.detach();

    model.reply({ text: "I will read the review." });
    agents.sendReview(task.id, [{ path: "README.md", side: "new", line: 1, code: "# shop", text: "Say what shop is." }]);
    await endOfTurn(resumed);

    const last = model.requests().at(-1);
    expect(last?.lastUserText).toContain("sent a review of your changes in Trackwall");
    expect(last).toMatchObject({ model: TASK_MODEL });
    // The conversation goes on: the model gets the first prompt again with the review.
    expect(JSON.stringify(last)).toContain("add a login test");
    await agents.stop(resumed);
  });
});

describe("secrets from mise in the conversation view with the real Copilot CLI (ADR-93, ADR-136)", () => {
  test("--secret-env-vars keeps a secret out of the shell of a task in the conversation view, as in a terminal", async () => {
    const secret = "provider-key-from-age-0123456789";
    const withMise = await startRealCopilotDaemon(model, {
      repos: {
        shop: {
          "README.md": "# shop\n",
          "fake-mise.json": JSON.stringify({
            tasks: [],
            env: { SHOP_PROVIDER_KEY: secret, SHOP_REGION: "eu-central" },
            redacted: ["SHOP_PROVIDER_KEY"],
          }),
        },
      },
      miseCommand: [process.execPath, join(import.meta.dir, "..", "test", "fixtures", "fake-mise.ts")],
    });
    try {
      const { agents } = withMise.facade;
      model.reply(
        (request) =>
          shellCall(request, {
            bash: 'echo "key=$SHOP_PROVIDER_KEY region=$SHOP_REGION"',
            powershell: 'Write-Output "key=$env:SHOP_PROVIDER_KEY region=$env:SHOP_REGION"',
          }),
        { text: "Printed them." },
      );

      const task = await agents.createTask("shop", "print the provider settings", { view: "conversation", approvals: "auto" });
      const [session] = agents.sessions().sessions.filter((s) => s.task === task.id);
      if (session === undefined) throw new Error("the task has no session");
      await waitFor(agents, session.id, (s) => s.state?.reason === "stop end_turn", "end of turn", SESSION_MS);

      expect(session.environment).toMatchObject({ secrets: ["SHOP_PROVIDER_KEY"], agentSecrets: [] });
      const printed = model.requests().at(-1)?.toolResults.join("\n") ?? "";
      expect(printed).toContain("key= region=eu-central");
      expect(printed).not.toContain(secret);
      await agents.stop(session.id);
    } finally {
      await withMise.stop();
    }
  });
});

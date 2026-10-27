import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { MCP_SERVER_NAME, mcpTools, type Session, TASK_MESSAGE_RULE } from "@trackwall/protocol";
import { windowTitleFromOsc } from "../src/modules/agents/copilot-osc.ts";
import { inboxPrompt } from "../src/modules/agents/inbox-prompt.ts";
import { OscParser } from "../src/modules/agents/osc-parser.ts";
import { viewer, waitFor } from "../test/support/agents.ts";
import { REFERENCE_COLS, REFERENCE_ROWS } from "../test/support/copilot-reference.ts";
import { untilInputBox } from "../test/support/screen-lines.ts";
import { hookRecords, startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type Recorder, startRecorder } from "./support/recorder.ts";
import { type ModelRequest, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";
import { USER_MCP_ISSUES, USER_MCP_SERVER, USER_MCP_TOOL } from "./support/user-mcp-server.ts";

const USER_MCP_SERVER_SCRIPT = join(import.meta.dir, "support", "user-mcp-server.ts");

// The contract with the real Copilot CLI (ADR-67): what the daemon relies on, checked on the pinned version with a
// scripted model. A failure here after a Copilot CLI upgrade means the fake in test/fixtures is out of date too.

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
let recorder: Recorder;
/** The terminal of each session a test started, detached after the test. */
const windows = new Map<string, ReturnType<typeof viewer>>();

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model);
  recorder = startRecorder(daemon);
});

// The tests share one daemon and one model: a test must take every reply it queued and leave no refused request.
afterEach(() => {
  for (const window of windows.values()) window.attachment.detach();
  windows.clear();
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

// The reference is checked last, after the sessions are stopped, so a difference does not leave Copilot CLI running;
// what was seen is printed even when stopping fails, whose error is then the one reported.
afterAll(async () => {
  let stopError: unknown;
  await daemon
    .stop()
    .then(() => model.close())
    .catch((err: unknown) => {
      stopError = err;
    });
  try {
    recorder.finish();
  } catch (err) {
    throw stopError ?? err;
  }
  if (stopError !== undefined) throw stopError;
});

/** A tool of the Trackwall MCP server as Copilot CLI names it to the model: the server's key, a dash, the tool. */
const copilotToolName = (tool: string) => `${MCP_SERVER_NAME}-${tool}`;

/** The shell tool Copilot CLI gives the model: `powershell` on Windows, `bash` elsewhere. */
function shellCall(request: ModelRequest, command: { bash: string; powershell: string }) {
  const tool = request.tools.includes("powershell") ? "powershell" : "bash";
  return { tool, arguments: { command: command[tool], description: "Create a file" } };
}

/**
 * How long a session may take to start and to finish a turn: a cold ~170 MB binary that Windows Defender scans.
 */
const SESSION_MS = 60_000;
// A test waits for at most three such steps; its own limit is above their sum, so a slow step fails on its own message.
setDefaultTimeout(4 * SESSION_MS);

type Daemon = typeof daemon;

/**
 * Waits until Copilot CLI in session `id` has loaded: its input box is on the screen, which it draws once its loading
 * line is gone, and the daemon's MCP server has answered its `tools/list`. Not the "1 MCP server" in the loading line:
 * Copilot CLI draws the line by changed cells and may replace it with the footer without ever drawing that part, and
 * when it falls back to the older MCP revision (with `initialize`) the line ends before `tools/list` is answered.
 */
function untilLoaded(id: string, on: Daemon = daemon) {
  const loaded = (s: Session) => s.state !== null && on.hasListedTools(id);
  return waitFor(on.facade.agents, id, loaded, "Copilot CLI with its input box and the Trackwall MCP tools", SESSION_MS);
}

/** The terminal of session `id`, kept until the end of the test, in the size the reference is taken in. */
function openWindow(id: string, on: Daemon = daemon) {
  const window = viewer(on.facade.agents, id);
  windows.set(id, window);
  window.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
  return window;
}

/** Starts a session in `shop` and waits until Copilot CLI has loaded. */
async function startSession() {
  const started = await daemon.facade.agents.start("shop");
  const window = openWindow(started.id);
  await untilLoaded(started.id);
  return { id: started.id, window };
}

function windowOf(id: string): ReturnType<typeof viewer> {
  const window = windows.get(id);
  if (window === undefined) throw new Error(`no terminal of session ${id}`);
  return window;
}

const endOfTurn = (id: string) => waitFor(daemon.facade.agents, id, (s) => s.state?.reason === "hook agentStop", "end of turn", SESSION_MS);

describe("a session of the real Copilot CLI", () => {
  test("sessionStart comes only with the first prompt, and a turn ending in text goes working and back to waiting", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    // Copilot CLI is ready for input, but it has sent no hook yet: the daemon reads its input box from the screen (ADR-69).
    const ready = await waitFor(agents, id, (s) => s.state !== null, "the input box of a new session", SESSION_MS);
    expect(ready.state).toMatchObject({ state: "Input", source: "screen", reason: "screen input box before the first prompt" });
    expect(ready.needsAttention).toBe(true);
    expect(hookRecords(daemon.home, id)).toEqual([]);
    await recorder.promptBox(window);

    model.reply({ text: "The shop repo has only a README." });
    const typedAt = Date.now();
    window.attachment.input("what is in this repo?\r");
    const done = await endOfTurn(id);

    expect(done.state).toMatchObject({ state: "Input", source: "hook", confidence: "high" });
    expect(model.requests().at(-1)?.lastUserText).toEndWith("what is in this repo?");
    const records = hookRecords(daemon.home, id);
    expect(records.map((r) => r.event)).toEqual(["sessionStart", "userPromptSubmitted", "agentStop"]);
    expect(records[0]?.receivedAt).toBeGreaterThanOrEqual(typedAt);
    // The payload fields the detectors read, and the names of the others, are in the reference: a new or renamed field
    // shows up there.
    expect(records[0]?.payload.source).toBe("new");
    expect(records[2]?.payload.stopReason).toBe("end_turn");
    recorder.turn(records);
    recorder.titles(window, "what is in this repo?");
    // ConPTY on Windows first sets the title to the path of the program it started, which the daemon leaves out.
    const titles = new OscParser().feed(window.text()).flatMap((osc) => windowTitleFromOsc(osc, null) ?? []);
    if (process.platform === "win32") expect(titles[0]).toBe(daemon.copilot);
    expect(done.windowTitle).not.toBe(daemon.copilot);
  });

  test("a shell command asks for approval as a permission_prompt notification, the daemon reads the dialog, and its answer runs it", async () => {
    const { agents } = daemon.facade;
    const { id } = await startSession();
    const repoDir = join(daemon.projects, "shop");

    model.reply((request) => shellCall(request, { bash: "touch made-by-agent.txt", powershell: "New-Item made-by-agent.txt" }));
    windowOf(id).attachment.input("create a file\r");
    const approval = await waitFor(agents, id, (s) => s.state?.state === "Approval" && s.dialog !== null, "approval dialog", SESSION_MS);
    expect(approval.state).toMatchObject({ source: "hook", confidence: "high", reason: "hook notification permission_prompt" });
    // The dialog as the tray panel and Home show it (ADR-66), read from the real Copilot CLI's screen. Only "Yes" is
    // checked among the options: for a PowerShell command on Windows the dialog came with "Yes" alone.
    const { dialog } = approval;
    if (dialog?.kind !== "approval") throw new Error(`no approval dialog: ${JSON.stringify(dialog)}`);
    const dialogBox = await recorder.dialogBox(windowOf(id));
    expect(dialog).toMatchObject({ title: "Create a file", question: "Do you want to run this command?" });
    expect(dialog.detail.join(" ")).toContain("made-by-agent.txt");
    expect(dialog.options[0]).toEqual({ key: "1", label: "Yes" });
    expect(existsSync(join(repoDir, "made-by-agent.txt"))).toBe(false);

    model.reply({ text: "Created the file." });
    agents.answerDialog(id, dialog.id, "1");
    await endOfTurn(id);
    expect(existsSync(join(repoDir, "made-by-agent.txt"))).toBe(true);
    const records = hookRecords(daemon.home, id);
    expect(records.map((r) => r.event)).toEqual(["sessionStart", "userPromptSubmitted", "notification", "postToolUse", "agentStop"]);
    expect(records[2]?.payload).toMatchObject({ notification_type: "permission_prompt" });
    recorder.approval(records, dialogBox);
  });

  test("an MCP tool approval taller than a short terminal loses its heading, and the daemon reads it with the notification's text", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    // A task terminal squeezed by the panels above it (1280×720 at 150%): the JSON arguments do not fit.
    window.attachment.resize(REFERENCE_COLS, 14);
    const note = Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n");

    model.reply({ tool: copilotToolName(mcpTools.verifyTask.name), arguments: { task: "no-such-task", note } });
    window.attachment.input("verify the task\r");
    const approval = await waitFor(agents, id, (s) => s.state?.state === "Approval" && s.dialog !== null, "approval dialog", SESSION_MS);
    const { dialog } = approval;
    if (dialog?.kind !== "approval") throw new Error(`no approval dialog: ${JSON.stringify(dialog)}`);
    expect(dialog).toMatchObject({
      title: `Use MCP tool: ${MCP_SERVER_NAME}/${mcpTools.verifyTask.name}`,
      question: "Do you want to use this tool?",
    });
    expect(dialog.detail[0]).toBe("…");
    expect(dialog.options[0]).toEqual({ key: "1", label: "Yes" });

    model.reply({ text: "There is no such task." });
    agents.answerDialog(id, dialog.id, "1");
    await endOfTurn(id);
  });

  test("a deny rule from toolPermissions reaches Copilot CLI as --deny-tool, which refuses the command without asking", async () => {
    const { agents } = daemon.facade;
    const workspaceFile = join(daemon.home, "workspace.yaml");
    const workspace = readFileSync(workspaceFile, "utf8");
    writeFileSync(workspaceFile, `${workspace}toolPermissions:\n  - repos: [shop]\n    deny: ["shell(touch)", "shell(New-Item)"]\n`);
    try {
      const { id } = await startSession();
      model.reply((request) => shellCall(request, { bash: "touch denied.txt", powershell: "New-Item denied.txt" }), {
        text: "The command was refused.",
      });
      windowOf(id).attachment.input("create a file\r");
      await endOfTurn(id);

      expect(existsSync(join(daemon.projects, "shop", "denied.txt"))).toBe(false);
      expect(hookRecords(daemon.home, id).map((r) => r.event)).not.toContain("notification");
      expect(agents.session(id).dialog).toBeNull();
    } finally {
      writeFileSync(workspaceFile, workspace);
    }
  });

  test("the agent gets every Trackwall MCP tool over HTTP from the daemon and the session instructions in its prompt", async () => {
    const { id, window } = await startSession();

    model.reply({ tool: copilotToolName(mcpTools.listRepos.name), arguments: {} }, { text: "There is one repo." });
    window.attachment.input("which repos are there?\r");
    await endOfTurn(id);

    const [first, second] = model.requests().slice(-2);
    const trackwallTools = (first?.tools ?? []).filter((t) => t.startsWith(copilotToolName(""))).sort();
    expect(trackwallTools).toEqual(
      Object.values(mcpTools)
        .map((tool) => copilotToolName(tool.name))
        .sort(),
    );
    expect(first?.system).toContain("You are a main session in the root of the repo `shop`");
    expect(second?.toolResults.join("\n")).toContain('"id":"shop"');
    // A read-only Trackwall tool runs without an approval request.
    expect(hookRecords(daemon.home, id).map((r) => r.event)).not.toContain("notification");
  });

  test("/exit ends the session with sessionEnd, and the session is Done", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    model.reply({ text: "Hello." });
    window.attachment.input("hello\r");
    await endOfTurn(id);

    // agentStop comes before Copilot CLI shows its input box again, and a line typed in between can be lost (it once was
    // on macOS), so the command is typed into the box once it is there, and sent once it shows.
    await untilInputBox(window, "empty");
    window.attachment.input("/exit");
    await untilInputBox(window, "text");
    window.attachment.input("\r");
    const done = await waitFor(agents, id, (s) => s.run.kind === "exited", "end of session", SESSION_MS);
    expect(done.state).toMatchObject({ state: "Done", source: "hook", reason: "hook sessionEnd user_exit" });
    const records = hookRecords(daemon.home, id);
    recorder.exit(records.slice(records.findIndex((r) => r.event === "agentStop") + 1));
  });
});

describe("an agent task with the real Copilot CLI", () => {
  /** The newest session of task `id`. */
  function taskSessionOf(id: string): string {
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === id);
    if (session === undefined) throw new Error(`task ${id} has no session`);
    return session.id;
  }

  test("the task's prompt reaches the model as the first message, in the task worktree, without typing", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Starting on the login test." });
    const task = await agents.createTask("shop", "add a login test");
    await endOfTurn(taskSessionOf(task.id));

    const first = model.requests().at(-1);
    expect(first?.lastUserText).toContain("add a login test");
    // Copilot CLI names its working directory by the real path (macOS: /private/var/… for the temporary /var/…).
    expect(first?.system).toContain(realpathSync.native(task.worktree));
  });

  test("a review sent to a resumed task session goes into its input box before the user types anything", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Added the test." });
    const task = await agents.createTask("shop", "add a checkout test");
    const first = taskSessionOf(task.id);
    await endOfTurn(first);
    await agents.stop(first);

    await agents.resumeTask(task.id);
    const resumed = taskSessionOf(task.id);
    await waitFor(agents, resumed, (s) => s.state !== null, "the input box of the resumed session", SESSION_MS);
    expect(hookRecords(daemon.home, resumed)).toEqual([]);
    model.reply({ text: "I will read the review." });
    agents.sendReview(task.id, [{ path: "README.md", side: "new", line: 1, code: "# shop", text: "Say what shop is." }]);
    await endOfTurn(resumed);

    expect(model.requests().at(-1)?.lastUserText).toContain("sent a review of your changes in Trackwall");
    expect(hookRecords(daemon.home, resumed).map((r) => r.event)).toEqual(["sessionStart", "userPromptSubmitted", "agentStop"]);
    await agents.stop(resumed);
  });
});

describe("a review of a task's changes with the real Copilot CLI (ADR-62)", () => {
  test("the agent asked to read the review reads the comments without an approval request", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Added the test." });
    const task = await agents.createTask("shop", "add a login test");
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");
    await endOfTurn(session.id);
    // The daemon types only once Copilot CLI has drawn its input box again after agentStop (ADR-68).
    const window = viewer(agents, session.id);
    windows.set(session.id, window);
    window.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
    await untilInputBox(window, "empty");

    model.reply({ tool: copilotToolName(mcpTools.getReviewComments.name), arguments: {} }, { text: "Renamed it." });
    const review = { path: "README.md", side: "new" as const, line: 1, code: "# shop", text: "Call it @login-test" };
    expect(agents.sendReview(task.id, [review]).delivery).toBe("typed");
    await waitFor(
      agents,
      session.id,
      // An approval request ends the wait at once, so a regression fails on its cause, not on the time limit.
      () => hookRecords(daemon.home, session.id).filter((r) => r.event === "agentStop" || r.event === "notification").length >= 2,
      "the review turn's end or an approval request",
      SESSION_MS,
    );

    expect(hookRecords(daemon.home, session.id).map((r) => r.event)).not.toContain("notification");
    expect(model.requests().at(-1)?.toolResults.join("\n")).toContain("Call it @login-test");
  });
});

describe("what waits for a working session, given through the hooks' output with the real Copilot CLI (ADR-85)", () => {
  test("a review sent while the agent works blocks the end of its turn, and the next turn starts with the prompt without typing", async () => {
    const { agents } = daemon.facade;
    let taskId: string | undefined;
    let delivery: string | undefined;
    const review = { path: "README.md", side: "new" as const, line: 1, code: "# shop", text: "Mention the signup page" };
    // The review goes out while Copilot CLI waits for the model's answer, so the turn is still running.
    model.reply(
      () => {
        if (taskId === undefined) throw new Error("the task's first request came before the task was created");
        delivery = agents.sendReview(taskId, [review]).delivery;
        return { text: "Added the signup test." };
      },
      { text: "I will read the review." },
    );
    const task = await agents.createTask("shop", "add a signup test");
    taskId = task.id;
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");

    await waitFor(
      agents,
      session.id,
      () => hookRecords(daemon.home, session.id).filter((r) => r.event === "agentStop").length >= 2,
      "the turn the review starts",
      SESSION_MS,
    );

    expect(delivery).toBe("queued");
    expect(model.requests().at(-1)?.lastUserText).toContain("sent a review of your changes in Trackwall");
    // The second turn was started by the block, so its end is not blocked again.
    expect(hookRecords(daemon.home, session.id).map((r) => [r.event, r.payload.stop_hook_active])).toEqual([
      ["sessionStart", undefined],
      ["userPromptSubmitted", undefined],
      ["agentStop", false],
      ["userPromptSubmitted", undefined],
      ["agentStop", true],
    ]);
    await agents.stop(session.id);
  });

  test("a review sent while a tool runs reaches the agent with the tool's result, in the same turn", async () => {
    const { agents } = daemon.facade;
    let taskId: string | undefined;
    const review = { path: "README.md", side: "new" as const, line: 1, code: "# shop", text: "Mention the signup page" };
    model.reply(
      () => {
        if (taskId === undefined) throw new Error("the task's first request came before the task was created");
        agents.sendReview(taskId, [review]);
        return { tool: copilotToolName(mcpTools.getMessages.name), arguments: {} };
      },
      { text: "I will read the review." },
      { text: "Reading it." },
    );
    const task = await agents.createTask("shop", "add a signup test");
    taskId = task.id;
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");

    await waitFor(
      agents,
      session.id,
      () => hookRecords(daemon.home, session.id).filter((r) => r.event === "agentStop").length >= 2,
      "the turn the review's block starts",
      SESSION_MS,
    );

    const [, afterTool, blocked] = model.requests().slice(-3);
    expect(afterTool?.toolResults.join("\n")).toContain("sent a review of your changes in Trackwall");
    expect(afterTool?.lastUserText).not.toContain("sent a review of your changes in Trackwall");
    expect(blocked?.lastUserText).toContain("sent a review of your changes in Trackwall");
    expect(hookRecords(daemon.home, session.id).map((r) => r.event)).toEqual([
      "sessionStart",
      "userPromptSubmitted",
      "postToolUse",
      "agentStop",
      "userPromptSubmitted",
      "agentStop",
    ]);
    await agents.stop(session.id);
  });
});

describe("a proposer and its task with the real Copilot CLI (ADR-68)", () => {
  /** Waits until session `id` has ended `turns` turns (its `agentStop` hook records). */
  const turnsEnded = (id: string, turns: number) =>
    waitFor(
      daemon.facade.agents,
      id,
      () => hookRecords(daemon.home, id).filter((r) => r.event === "agentStop").length >= turns,
      `${turns} ended turns`,
      SESSION_MS,
    );

  // Six steps of SESSION_MS, more than the file's limit: the start and five ended turns.
  test(
    "the prompt the daemon types is the agent's next message, and the message and updates reach it through the tools",
    async () => {
      const { agents } = daemon.facade;
      const main = await startSession();
      model.reply({ text: "Hello." });
      main.window.attachment.input("hello\r");
      await turnsEnded(main.id, 1);

      // The task's first turn ends: the main session is asked to read the update and reads it.
      model.reply(
        { text: "Starting on the login test." },
        { tool: copilotToolName(mcpTools.getUpdates.name), arguments: {} },
        { text: "The task has started." },
      );
      const proposal = await agents.propose(main.id, { repo: "shop", title: "Add a login test", prompt: "add a login test" });
      const task = await agents.approveProposal(proposal.id, "add a login test");
      const session = agents.sessions().sessions.find((s) => s.task === task.id);
      if (session === undefined) throw new Error("the task has no session");
      await turnsEnded(session.id, 1);
      await turnsEnded(main.id, 2);

      // A message with what the input box would mangle: an @, a leading slash and a line break.
      const text = "/keep the old endpoint\n@Deprecated callers still use it";
      model.reply(
        { tool: copilotToolName(mcpTools.getMessages.name), arguments: {} },
        { text: "Kept the old endpoint." },
        { text: "The task kept the old endpoint." },
      );
      expect(agents.sendMessage(main.id, task.id, text).delivery).toBe("typed");
      await turnsEnded(session.id, 2);
      await turnsEnded(main.id, 3);

      const requests = model.requests();
      const updatesPrompt = inboxPrompt({ reviewComments: 0, messages: 0, updates: 1, trustNotice: false });
      const messagesPrompt = inboxPrompt({ reviewComments: 0, messages: 1, updates: 0, trustNotice: false });
      const readUpdates = requests.findIndex((r) => r.lastUserText.endsWith(updatesPrompt ?? "-"));
      expect(requests[readUpdates + 1]?.toolResults.join("\n")).toContain('"kind":"turn_ended"');
      const readMessages = requests.findIndex((r) => r.lastUserText.endsWith(messagesPrompt ?? "-"));
      expect(requests[readMessages + 1]?.toolResults.join("\n")).toContain(JSON.stringify(text).slice(1, -1));
      // The agent reading the message has the rule that it updates the task over the prompt in its instructions.
      expect(requests[readMessages]?.system).toContain(TASK_MESSAGE_RULE);
      expect(requests.at(-1)?.lastUserText).toEndWith(updatesPrompt ?? "-");
    },
    7 * SESSION_MS,
  );
});

describe("the supervisor with the real Copilot CLI", () => {
  test("Copilot CLI refuses the supervisor its shell and its file-writing tools without asking, and the projects folder stays as it was (ADR-78)", async () => {
    const { agents } = daemon.facade;
    const supervisor = await agents.startSupervisor();
    const window = openWindow(supervisor.id);
    await untilLoaded(supervisor.id);
    model.reply(
      (request) => shellCall(request, { bash: "touch by-shell.txt", powershell: "New-Item by-shell.txt" }),
      (request) => {
        expect(request.tools).toContain("create");
        return { tool: "create", arguments: { path: join(daemon.projects, "by-create.txt"), file_text: "x" } };
      },
      { text: "Both were refused." },
    );

    window.attachment.input("make two files\r");
    await endOfTurn(supervisor.id);

    const [, second, third] = model.requests().slice(-3);
    expect(second?.toolResults.join("\n")).toContain("denied");
    expect(third?.toolResults.join("\n")).toContain("denied");
    expect(existsSync(join(daemon.projects, "by-shell.txt"))).toBe(false);
    expect(existsSync(join(daemon.projects, "by-create.txt"))).toBe(false);
    expect(hookRecords(daemon.home, supervisor.id).map((r) => r.event)).not.toContain("notification");
    expect(agents.session(supervisor.id).dialog).toBeNull();
    await agents.stop(supervisor.id);
  });
});

describe("the day start with the real Copilot CLI", () => {
  test("the day start's first message reaches the new supervisor's model as its first prompt, next to the user's own MCP servers, and it reads the day report without an approval request", async () => {
    const { agents, dayStart } = daemon.facade;
    // One of the user's own MCP servers in their Copilot CLI config: Trackwall's server is added to it, not instead of it.
    const userConfig = join(daemon.home, "copilot-home", "mcp-config.json");
    const server = { type: "local", command: process.execPath, args: [USER_MCP_SERVER_SCRIPT], tools: ["*"] };
    mkdirSync(dirname(userConfig), { recursive: true });
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { [USER_MCP_SERVER]: server } }));
    model.reply(
      { tool: copilotToolName(mcpTools.getDayReport.name), arguments: {} },
      { tool: `${USER_MCP_SERVER}-${USER_MCP_TOOL}`, arguments: {} },
      { text: "Nothing new since your last day start; one open issue." },
    );

    try {
      await dayStart.start();
      const until = Date.now() + SESSION_MS;
      while (dayStart.run()?.finishedAt === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      const run = dayStart.run();
      expect(run).toMatchObject({ error: null, step: "supervisor" });
      const supervisor = run?.supervisor;
      if (!supervisor) throw new Error("the day start started no supervisor");
      await endOfTurn(supervisor);

      const [first, second, third] = model.requests().slice(-3);
      expect(first?.lastUserText).toContain(`Start my day. Trackwall has just synced every repo; call ${mcpTools.getDayReport.name}`);
      expect(first?.system).toContain("You are the supervisor");
      expect(first?.tools).toContain(copilotToolName(mcpTools.getDayReport.name));
      expect(first?.tools).toContain(`${USER_MCP_SERVER}-${USER_MCP_TOOL}`);
      expect(second?.toolResults.join("\n")).toContain('"quietRepos":1');
      expect(third?.toolResults.join("\n")).toContain(USER_MCP_ISSUES);
      expect(hookRecords(daemon.home, supervisor).map((r) => r.event)).not.toContain("notification");
      await agents.stop(supervisor);
    } finally {
      rmSync(userConfig, { force: true });
    }
  });
});

describe("session plugin hooks over HTTP with the real Copilot CLI (ADR-88)", () => {
  test("a hook the daemon answers with an error does not hold up the turn: Copilot CLI goes on to the model and to the end of the turn", async () => {
    // A stand-in for a daemon that cannot take the hooks: it answers every POST with 500 and keeps the event of each.
    const refused: string[] = [];
    const standIn = createServer((req, res) => {
      refused.push(req.url ?? "");
      req.resume();
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    const port = (standIn.address() as AddressInfo).port;
    const broken = await startRealCopilotDaemon(model, {
      sessionHook: (event) => ({ url: `http://127.0.0.1:${port}/hooks/${event}`, headers: {} }),
    });
    try {
      const { agents } = broken.facade;
      const started = await agents.start("shop");
      const window = viewer(agents, started.id);
      window.attachment.resize(REFERENCE_COLS, REFERENCE_ROWS);
      await untilInputBox(window, "empty");
      model.reply({ text: "The shop repo has only a README." });

      window.attachment.input("what is in this repo?\r");
      const until = Date.now() + SESSION_MS;
      while (!refused.includes("/hooks/agentStop") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));

      expect(refused).toEqual(["/hooks/sessionStart", "/hooks/userPromptSubmitted", "/hooks/agentStop"]);
      expect(model.requests().at(-1)?.lastUserText).toEndWith("what is in this repo?");
      expect(hookRecords(broken.home, started.id)).toEqual([]);
      window.attachment.detach();
      await agents.stop(started.id);
    } finally {
      await broken.stop();
      standIn.close();
    }
  });
});

describe("the daemon's MCP server with the real Copilot CLI behind the user's proxy (ADR-89)", () => {
  test("with HTTP_PROXY set and no NO_PROXY the session still reaches the MCP server, the hooks and the model on 127.0.0.1", async () => {
    // A proxy that answers nothing: whatever Copilot CLI sends through it fails.
    const deadProxy = "http://127.0.0.1:9";
    const proxied = await startRealCopilotDaemon(
      model,
      {},
      {
        HTTP_PROXY: deadProxy,
        http_proxy: deadProxy,
        HTTPS_PROXY: deadProxy,
        https_proxy: deadProxy,
        NO_PROXY: undefined,
        no_proxy: undefined,
      },
    );
    try {
      const { agents } = proxied.facade;
      const started = await agents.start("shop");
      const window = openWindow(started.id, proxied);
      await untilLoaded(started.id, proxied);
      model.reply({ tool: copilotToolName(mcpTools.listRepos.name), arguments: {} }, { text: "There is one repo." });

      window.attachment.input("which repos are there?\r");
      await waitFor(agents, started.id, (s) => s.state?.reason === "hook agentStop", "end of turn", SESSION_MS);

      expect(model.requests().at(-1)?.toolResults.join("\n")).toContain('"id":"shop"');
      expect(hookRecords(proxied.home, started.id).map((r) => r.event)).toEqual([
        "sessionStart",
        "userPromptSubmitted",
        "postToolUse",
        "agentStop",
      ]);
      window.attachment.detach();
      await agents.stop(started.id);
    } finally {
      await proxied.stop();
    }
  });
});

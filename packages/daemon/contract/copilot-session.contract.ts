import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mcpTools } from "@trackwall/protocol";
import { viewer, waitFor } from "../test/support/agents.ts";
import { hookRecords, startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ModelRequest, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// The contract with the real Copilot CLI (ADR-67): what the daemon relies on, checked on the pinned version with a
// scripted model. A failure here after a Copilot CLI upgrade means the fake in test/fixtures is out of date too.

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model);
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

/** Starts a session in `shop` and waits until Copilot CLI shows its input box with the MCP servers loaded. */
async function startSession() {
  const { agents } = daemon.facade;
  const started = await agents.start("shop");
  const window = viewer(agents, started.id);
  await waitFor(agents, started.id, () => window.unwrappedText().includes("1 MCP server"), "Copilot CLI loaded");
  return { id: started.id, window };
}

describe("a session of the real Copilot CLI", () => {
  test("sessionStart comes only with the first prompt, and a turn ending in text goes working and back to waiting", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    // Copilot CLI is ready for input, but it has sent no hook yet, so the session has no state.
    expect(hookRecords(daemon.home, id)).toEqual([]);
    expect(agents.session(id).state).toBeNull();

    model.reply({ text: "The shop repo has only a README." });
    window.attachment.input("what is in this repo?\r");
    const done = await waitFor(agents, id, (s) => s.state?.reason === "hook agentStop", "end of turn");

    expect(done.state).toMatchObject({ state: "Input", source: "hook", confidence: "high" });
    expect(model.requests().at(-1)?.lastUserText).toEndWith("what is in this repo?");
    const records = hookRecords(daemon.home, id);
    expect(records.map((r) => r.event)).toEqual(["sessionStart", "userPromptSubmitted", "agentStop"]);
    // The payload fields the detectors read, and the names of the others: a new or renamed field shows up here.
    expect(records.map((r) => ({ event: r.event, fields: Object.keys(r.payload).sort(), omitted: r.omitted.sort() }))).toEqual([
      { event: "sessionStart", fields: ["sessionId", "source", "timestamp"], omitted: ["cwd", "initialPrompt"] },
      { event: "userPromptSubmitted", fields: ["sessionId", "timestamp"], omitted: ["cwd", "prompt"] },
      { event: "agentStop", fields: ["sessionId", "stopReason", "timestamp"], omitted: ["cwd", "stop_hook_active", "transcriptPath"] },
    ]);
    expect(records[0]?.payload.source).toBe("new");
    expect(records[2]?.payload.stopReason).toBe("end_turn");
    expect(model.unexpected()).toEqual([]);
    window.attachment.detach();
  }, 90_000);

  test("a shell command asks for approval as a permission_prompt notification, and 1 runs it", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    const repoDir = join(daemon.projects, "shop");

    model.reply((request) => shellCall(request, { bash: "touch made-by-agent.txt", powershell: "New-Item made-by-agent.txt" }));
    window.attachment.input("create a file\r");
    const approval = await waitFor(agents, id, (s) => s.state?.state === "Approval", "approval request");
    expect(approval.state).toMatchObject({ source: "hook", confidence: "high", reason: "hook notification permission_prompt" });
    expect(window.unwrappedText()).toContain("Do you want to run this command?");
    expect(existsSync(join(repoDir, "made-by-agent.txt"))).toBe(false);

    model.reply({ text: "Created the file." });
    window.attachment.input("1");
    await waitFor(agents, id, (s) => s.state?.reason === "hook agentStop", "end of turn");
    expect(existsSync(join(repoDir, "made-by-agent.txt"))).toBe(true);
    expect(hookRecords(daemon.home, id).map((r) => r.event)).toEqual([
      "sessionStart",
      "userPromptSubmitted",
      "notification",
      "postToolUse",
      "agentStop",
    ]);
    const notification = hookRecords(daemon.home, id).find((r) => r.event === "notification");
    expect(notification?.payload).toMatchObject({ notification_type: "permission_prompt" });
    expect(model.unexpected()).toEqual([]);
    window.attachment.detach();
  }, 90_000);

  test("the agent gets every Trackwall MCP tool through the session's stdio bridge and the session instructions in its prompt", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();

    model.reply({ tool: `trackwall-${mcpTools.listRepos.name}`, arguments: {} }, { text: "There is one repo." });
    window.attachment.input("which repos are there?\r");
    await waitFor(agents, id, (s) => s.state?.reason === "hook agentStop", "end of turn");

    const [first, second] = model.requests().slice(-2);
    const trackwallTools = (first?.tools ?? []).filter((t) => t.startsWith("trackwall-")).sort();
    expect(trackwallTools).toEqual(
      Object.values(mcpTools)
        .map((tool) => `trackwall-${tool.name}`)
        .sort(),
    );
    expect(first?.system).toContain("You are a main session in the root of the repo `shop`");
    expect(second?.toolResults.join("\n")).toContain('"id":"shop"');
    expect(model.unexpected()).toEqual([]);
    window.attachment.detach();
  }, 90_000);

  test("/exit ends the session with sessionEnd, and the session is Done", async () => {
    const { agents } = daemon.facade;
    const { id, window } = await startSession();
    model.reply({ text: "Hello." });
    window.attachment.input("hello\r");
    await waitFor(agents, id, (s) => s.state?.reason === "hook agentStop", "end of turn");

    window.attachment.input("/exit\r");
    const done = await waitFor(agents, id, (s) => s.run.kind === "exited", "end of session");
    expect(done.state).toMatchObject({ state: "Done", source: "hook", reason: "hook sessionEnd user_exit" });
    window.attachment.detach();
  }, 90_000);
});

describe("an agent task with the real Copilot CLI", () => {
  test("the task's prompt reaches the model as the first message, in the task worktree, without typing", async () => {
    const { agents } = daemon.facade;
    model.reply({ text: "Starting on the login test." });
    const task = await agents.createTask("shop", "add a login test");
    const session = agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");
    await waitFor(agents, session.id, (s) => s.state?.reason === "hook agentStop", "end of the task's first turn");

    const first = model.requests().at(-1);
    expect(first?.lastUserText).toContain("add a login test");
    expect(first?.system).toContain(task.worktree);
    expect(model.unexpected()).toEqual([]);
  }, 90_000);
});

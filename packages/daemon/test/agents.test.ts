import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, sessionHooksFile } from "../src/modules/agents/agents.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { isAlive } from "../src/platform/process-group.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { PARALLEL_TOOLS_PROMPT } from "./support/copilot-reference.ts";
import { untilInputBox } from "./support/screen-lines.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe.skipIf(process.versions.bun === undefined)("Copilot CLI sessions (real PTY, fake Copilot CLI)", () => {
  test("a session starts in the repo directory with the Trackwall MCP server, the state follows the hooks, and /exit ends it as Done", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs, home } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("shop");
    expect(started).toMatchObject({ repo: "shop", run: { kind: "running" } });

    // Copilot CLI sends no hook before the first prompt, so its input box on the screen says it waits for you (ADR-69).
    const waiting = await waitFor(agents, started.id, (s) => s.state !== null, "input box");
    expect(waiting.state).toMatchObject({ state: "Input", source: "screen", reason: "screen input box before the first prompt" });
    expect(waiting.needsAttention).toBe(true);

    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Welcome to the fake"), "screen image");
    expect(window.unwrappedText()).toContain(repoDir);
    expect(window.text()).toContain("MCP: trackwall");
    // Session instructions with the session's role come from the session directory, not from the repo (ADR-46).
    expect(window.text()).toContain("Instructions: trackwall.instructions.md");
    const instructions = readFileSync(join(home, "sessions", started.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("You are a main session in the root of the repo `shop`");
    expect(readdirSync(repoDir)).toEqual([]);
    // The session reaches the MCP server over HTTP with this session's token, by which the server knows who is calling (ADR-39, ADR-89).
    const mcpConfig = JSON.parse(readFileSync(join(home, "sessions", started.id, "mcp-config.json"), "utf8"));
    const sessionToken = mcpConfig.mcpServers.trackwall.headers["x-trackwall-session-token"];
    expect(mcpConfig.mcpServers.trackwall).toEqual({
      type: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { "x-trackwall-session-token": sessionToken },
      tools: ["*"],
    });
    expect(agents.callerSession(sessionToken)).toBe(started.id);
    expect(agents.callerSession("another token")).toBeUndefined();
    // Both files carry the daemon token and the session token, so only the user reads them (§8; Windows has no mode bits).
    if (process.platform !== "win32") {
      expect(statSync(join(home, "sessions", started.id, "mcp-config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "sessions", started.id, "plugin", "hooks.json")).mode & 0o777).toBe(0o600);
    }

    window.attachment.input("fix the test\r");
    const approval = await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "approval request");
    expect(approval.state).toMatchObject({ source: "hook", reason: "hook notification permission_prompt" });
    expect(approval.windowTitle).toBe("fix the test - GitHub Copilot");
    // The screen reaches a viewer only once the emulator has processed it (`TerminalScreen`), while the hook's state does
    // not wait for that, so the dialog is waited for: on macOS CI it once was not there yet.
    await waitFor(agents, started.id, () => window.text().includes("Do you want to run this command?"), "the dialog on the screen");

    window.attachment.input("1");
    await waitFor(agents, started.id, (s) => s.state?.reason === "hook agentStop", "end of turn");
    // Keys typed before the input box is drawn again are lost, as in Copilot CLI (ADR-68).
    await untilInputBox(window, "empty");

    window.attachment.input("/exit\r");
    const done = await waitFor(agents, started.id, (s) => s.run.kind === "exited", "end of session");
    expect(done.state).toMatchObject({ state: "Done", source: "hook" });
    expect(done.needsAttention).toBe(false);
    window.attachment.detach();
  }, 60_000);

  test("Esc at an approval request ends waiting for approval, although Copilot CLI sends no hook then", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Welcome"), "welcome screen");
    window.attachment.input("fix the test\r");
    await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "approval request");

    window.attachment.input("\u001b");
    const stopped = await waitFor(agents, started.id, (s) => s.state?.source === "keyboard", "state from the key");
    expect(stopped.state).toMatchObject({ state: "Input", confidence: "medium", reason: "key escape" });
    // The Esc the user typed means they see the session, so it is idle, not waiting for you (ADR-47).
    expect(stopped.needsAttention).toBe(false);
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("an approval cut above by a short terminal is read with the text of its notification as the heading", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Welcome"), "welcome screen");
    window.attachment.resize(100, 10);
    window.attachment.input("fix the test\r");

    const approval = await waitFor(agents, started.id, (s) => s.dialog !== null, "the approval dialog");
    expect(approval.dialog).toMatchObject({
      kind: "approval",
      title: expect.stringMatching(/^Run command: /),
      question: "Do you want to run this command?",
    });
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("two commands the agent runs at once keep the session waiting until both approvals are answered from outside the terminal (ADR-66)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs, home } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Welcome"), "welcome screen");

    window.attachment.input(`${PARALLEL_TOOLS_PROMPT}\r`);
    const first = await waitFor(agents, started.id, (s) => s.dialog?.kind === "approval", "the first approval dialog");
    if (first.dialog?.kind !== "approval") throw new Error("no approval dialog");
    expect(first.dialog.detail.join(" ")).toContain("made-by-agent");

    agents.answerDialog(started.id, first.dialog.id, "1");
    // The fake draws the second dialog and then sends the first command's postToolUse, as Copilot CLI does.
    await waitFor(
      agents,
      started.id,
      () => readFileSync(sessionHooksFile(home, started.id), "utf8").includes("postToolUse"),
      "postToolUse",
    );
    const second = await waitFor(
      agents,
      started.id,
      (s) => s.dialog?.kind === "approval" && s.dialog.detail.join(" ").includes("made-by-other"),
      "the second approval dialog",
    );
    expect(second.state).toMatchObject({ state: "Approval" });
    if (second.dialog?.kind !== "approval") throw new Error("no approval dialog");

    agents.answerDialog(started.id, second.dialog.id, "1");
    await waitFor(agents, started.id, (s) => s.state?.reason === "hook agentStop", "end of turn");
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("a terminal connected later gets the screen image with what the session has already printed", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());
    const started = await agents.start("shop");
    const first = viewer(agents, started.id);
    await waitFor(agents, started.id, () => first.text().includes("Welcome"), "welcome screen");
    first.attachment.input("first line\r");
    await waitFor(agents, started.id, (s) => s.state?.state === "Approval", "approval request");
    first.attachment.detach();

    const late = viewer(agents, started.id);
    await waitFor(agents, started.id, () => late.text().includes("Do you want to run this command?"), "screen image for the new terminal");
    expect(late.text()).toContain("Welcome to the fake");
    // Without the SGR encoding the window would encode the wheel and clicks the X10 way, and they would not reach Copilot CLI.
    expect(late.text()).toContain("\x1b[?1003h");
    expect(late.text()).toContain("\x1b[?1006h");
    late.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("stop stops the whole group with the helper process, and closing removes the session, its files and terminals", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, home } = makeAgents({ shop: repoDir });
    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    window.attachment.input("start the helper\r");
    await waitFor(agents, started.id, () => /helper PID: \d+/.test(window.text()), "helper process");
    const helperPid = Number(/helper PID: (\d+)/.exec(window.text())?.[1]);
    expect(isAlive(helperPid)).toBe(true);
    expect(() => agents.dismiss(started.id)).toThrow("the session is still running");

    const stopped = await agents.stop(started.id);
    expect(stopped.run).toMatchObject({ kind: "exited", stoppedByUser: true });
    expect(stopped.state?.state).toBe("Done");
    expect(isAlive(helperPid)).toBe(false);
    expect(existsSync(join(home, "sessions", started.id))).toBe(true);

    expect(window.closed()).toBe(false);
    expect(agents.dismiss(started.id).sessions).toEqual([]);
    expect(window.closed()).toBe(true);
    expect(existsSync(join(home, "sessions", started.id))).toBe(false);
  }, 60_000);

  test("a session starts with the workspace's tool permissions as Copilot CLI's own approval rules (ADR-66)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const permissions = { allow: ["shell(mvn:*)", "write"], deny: ["shell(git push)"] };
    const { agents, procs } = makeAgents({ shop: repoDir }, undefined, null, permissions);
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Argument: --deny-tool"), "tool permission arguments");

    expect(window.text()).toContain("Argument: --allow-tool=shell(mvn:*)");
    expect(window.text()).toContain("Argument: --allow-tool=write");
    expect(window.text()).toContain("Argument: --deny-tool=shell(git push)");
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("a session keeps the user's own MCP servers from $COPILOT_HOME/mcp-config.json next to Trackwall's (ADR-70)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const copilotHome = mkdtempSync(join(tmpdir(), "trackwall-copilot-home-"));
    writeFileSync(join(copilotHome, "mcp-config.json"), JSON.stringify({ mcpServers: { tracker: { command: "tracker-mcp" } } }));
    const { agents, procs } = makeAgents({ shop: repoDir }, undefined, null, undefined, { ...process.env, COPILOT_HOME: copilotHome });
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("shop");
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("Welcome to the fake"), "screen image");

    expect(window.text()).toContain("MCP: tracker, trackwall");
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("the supervisor starts in the projects folder, with no repo and the supervisor's instructions", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const { agents, procs, home } = makeAgents({}, undefined, projectsDir);
    cleanups.push(() => procs.stopAll());

    const supervisor = await agents.startSupervisor("new");
    expect(supervisor).toMatchObject({ repo: null, task: null, run: { kind: "running" } });
    const window = viewer(agents, supervisor.id);
    await waitFor(
      agents,
      supervisor.id,
      () => window.unwrappedText().includes(projectsDir),
      "the projects folder as the working directory",
    );
    const instructions = readFileSync(join(home, "sessions", supervisor.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("You are the supervisor");
    expect(instructions).toContain("Copilot CLI refuses you its shell and the tools that write files");
    window.attachment.detach();
    await agents.stop(supervisor.id);
  }, 60_000);

  test("a session in the repo root with a prompt gets it as its first message and works from the start (ADR-100)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ shop: repoDir });
    cleanups.push(() => procs.stopAll());

    const started = await agents.start("shop", "Fix the build");
    expect(started).toMatchObject({ repo: "shop", supervisor: false, task: null });
    const window = viewer(agents, started.id);
    await waitFor(agents, started.id, () => window.text().includes("--interactive="), "the first message on the screen");
    expect(window.unwrappedText()).toContain(`Argument: --session-id=${started.id}`);
    expect(window.unwrappedText()).toContain("Argument: --interactive=Fix the build");
    expect(window.unwrappedText()).toContain(repoDir);
    await waitFor(agents, started.id, (s) => s.state?.state === "Working" || s.state?.state === "Approval", "the first turn");
    expect(agents.sessions().tasks).toEqual([]);
    window.attachment.detach();
    await agents.stop(started.id);
  }, 60_000);

  test("free sessions start in the projects folder with their own instructions, next to the supervisor and to each other (ADR-100)", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs, home } = makeAgents({ shop: repoDir }, undefined, projectsDir);
    cleanups.push(() => procs.stopAll());
    const supervisor = await agents.startSupervisor("new");

    const free = await agents.start(null);
    const another = await agents.start(null, "Compare the two APIs");
    expect(free).toMatchObject({ repo: null, supervisor: false, task: null, run: { kind: "running" } });
    expect(another).toMatchObject({ repo: null, supervisor: false, run: { kind: "running" } });
    const window = viewer(agents, free.id);
    await waitFor(agents, free.id, () => window.unwrappedText().includes(projectsDir), "the projects folder as the working directory");
    const instructions = readFileSync(join(home, "sessions", free.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("You are a free session in the projects folder");
    expect(instructions).not.toContain("You are the supervisor");
    // A free session is no supervisor: the supervisor stays the one that runs, and what a free session proposes is its own.
    expect((await agents.startSupervisor("new")).id).toBe(supervisor.id);
    const proposal = await agents.propose(free.id, {
      repo: "shop",
      title: "Add a test",
      prompt: "Add a cart test",
      model: null,
      approvals: "ask",
    });
    expect(proposal.proposedBy).toEqual({ session: free.id, supervisor: false });
    window.attachment.detach();
    for (const session of [supervisor, free, another]) await agents.stop(session.id);
  }, 60_000);

  test("a free session needs the projects folder to be set (ADR-100)", async () => {
    const { agents } = makeAgents({});
    await expect(agents.start(null)).rejects.toMatchObject({ code: "bad_request", message: "set the projects folder first" });
  });

  test("a supervisor the user lets change code is told so in its instructions (ADR-78)", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const { agents, procs, home } = makeAgents({}, undefined, projectsDir, undefined, process.env, { changesCode: true });
    cleanups.push(() => procs.stopAll());

    const supervisor = await agents.startSupervisor("new");
    const instructions = readFileSync(join(home, "sessions", supervisor.id, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain("The user lets you run commands and change files yourself");
    await agents.stop(supervisor.id);
  }, 60_000);

  test("two starts at once, and a start while one runs, give the same supervisor", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());

    const [first, second] = await Promise.all([agents.startSupervisor("new"), agents.startSupervisor("new")]);
    expect(second.id).toBe(first.id);
    expect((await agents.startSupervisor("new")).id).toBe(first.id);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([first.id]);
    await agents.stop(first.id);
  }, 60_000);

  test("what the supervisor proposes is marked as the supervisor's, and what another session proposes is not", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs } = makeAgents({ shop: repoDir }, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const supervisor = await agents.startSupervisor("new");
    const session = await agents.start("shop");

    const fromSupervisor = await agents.propose(supervisor.id, {
      repo: "shop",
      title: "Fix the cart",
      prompt: "Fix the cart total",
      model: null,
      approvals: "ask",
    });
    const fromSession = await agents.propose(session.id, {
      repo: "shop",
      title: "Add a test",
      prompt: "Add a cart test",
      model: null,
      approvals: "ask",
    });
    expect(fromSupervisor.proposedBy).toEqual({ session: supervisor.id, supervisor: true });
    expect(fromSession.proposedBy).toEqual({ session: session.id, supervisor: false });
    await agents.stop(supervisor.id);
    await agents.stop(session.id);
  }, 60_000);

  test("a new supervisor replaces the ended one: the ended one is closed with its files, its proposals stay", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents, procs, home } = makeAgents({ shop: repoDir }, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const first = await agents.startSupervisor("new");
    const proposal = await agents.propose(first.id, {
      repo: "shop",
      title: "Fix the cart",
      prompt: "Fix the cart total",
      model: null,
      approvals: "ask",
    });
    await agents.stop(first.id);

    const next = await agents.startSupervisor("new");
    expect(next.id).not.toBe(first.id);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([next.id]);
    expect(existsSync(join(home, "sessions", first.id))).toBe(false);
    expect(agents.sessions().proposals.map((p) => p.id)).toEqual([proposal.id]);
    await agents.stop(next.id);
  }, 60_000);

  test("a supervisor with a first message gets it as its first prompt and works from the start, and replaces the ended one", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const ended = await agents.startSupervisor("new");
    await agents.stop(ended.id);

    const supervisor = await agents.startSupervisorWith("Start my day.\n\nCheck my issues.");
    const window = viewer(agents, supervisor.id);
    await waitFor(agents, supervisor.id, () => window.text().includes("--interactive="), "the first message on the screen");
    expect(window.unwrappedText()).toContain("Argument: --interactive=Start my day.");
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([supervisor.id]);
    // The first message is on its way, so the session works rather than waiting for input (ADR-69).
    await waitFor(agents, supervisor.id, (s) => s.state?.state === "Working" || s.state?.state === "Approval", "the first turn");
    window.attachment.detach();
    await agents.stop(supervisor.id);
  }, 60_000);

  test("a supervisor with a first message is refused while a supervisor starts or runs, so no conversation ends without the user", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());

    const starting = agents.startSupervisor("new");
    const refusal = "the supervisor is running; stop it to start your day with a new one";
    expect(() => agents.assertNoSupervisor()).toThrow(refusal);
    const running = await starting;
    await expect(agents.startSupervisorWith("Start my day.")).rejects.toThrow(refusal);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([running.id]);
    await agents.stop(running.id);
    expect(() => agents.assertNoSupervisor()).not.toThrow();
  }, 60_000);

  test("a supervisor start succeeds even when the ended supervisor is dismissed while it starts", async () => {
    const { agents, procs } = makeAgents({}, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    const first = await agents.startSupervisor("new");
    await agents.stop(first.id);

    const starting = agents.startSupervisor("new");
    agents.dismiss(first.id);
    const next = await starting;
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([next.id]);
    await agents.stop(next.id);
  }, 60_000);

  test("the supervisor needs the projects folder to be set", async () => {
    const { agents } = makeAgents({});
    await expect(agents.startSupervisor("new")).rejects.toMatchObject({ code: "bad_request", message: "set the projects folder first" });
    expect(agents.sessions().sessions).toEqual([]);
  });

  test("a missing Copilot CLI and an unknown repo are errors with a code, without a process", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trackwall-repo-"));
    const { agents } = makeAgents({ shop: repoDir });
    await expect(agents.start("other")).rejects.toMatchObject({ code: "not_found" });

    const missing = new Agents({
      procs: {
        startTerminal: () => Promise.reject(new Error("should not start")),
        state: () => undefined,
        stop: async () => undefined,
        liveIn: () => false,
      },
      repos: {
        repoPath: async () => repoDir,
        projectsDir: async () => repoDir,
        worktreesDir: async () => repoDir,
        toolPermissions: () => ({ allow: [], deny: [] }),
        supervisorSettings: () => ({ changesCode: false }),
        agentSecrets: () => [],
        removeRepo: () => Promise.reject(new Error("unused")),
      },
      vcs: new Vcs(),
      home: mkdtempSync(join(tmpdir(), "trackwall-agents-")),
      copilot: ["copilot-that-does-not-exist"],
      version: "0.0.0-test",
      env: async () => ({ PATH: repoDir }),
      miseEnv: async () => ({ vars: {}, secretNames: [], secretValues: [], problem: null }),
      sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
      sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
      openEditor: () => {},
      log: () => {},
    });
    await expect(missing.start("shop")).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(missing.sessions().sessions).toEqual([]);
  });
});

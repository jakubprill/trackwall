import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "s".repeat(43);
const RESUMABLE_FILE = "resumable-sessions.json";
const daemons: Awaited<ReturnType<typeof startSessionApi>>[] = [];

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
}, 30_000);

async function startDaemon(restartOf?: { home: string; projects: string }) {
  const daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"], restartOf });
  daemons.push(daemon);
  return daemon;
}

/** Stops the daemon as its exit does, so the sessions it ends stay to be resumed. */
async function stopDaemon(daemon: Awaited<ReturnType<typeof startSessionApi>>) {
  daemons.splice(daemons.indexOf(daemon), 1);
  await daemon.stop();
}

/** The session's screen, once it shows the Copilot CLI argument that starts with `prefix`. */
async function argumentOnScreen(daemon: Awaited<ReturnType<typeof startSessionApi>>, id: string, prefix: string) {
  // The next daemon resumes the sessions in the background, after its API listens.
  await waitFor(daemon.facade.agents, id, (s) => s.run.kind === "running", "the session started again");
  const window = viewer(daemon.facade.agents, id);
  await waitFor(daemon.facade.agents, id, () => window.text().includes(`Argument: ${prefix}`), `${prefix} on the screen`);
  window.attachment.detach();
  return window.text();
}

/** The session of task `task` once the next daemon has resumed it, under a new id. */
async function resumedSessionOf(daemon: Awaited<ReturnType<typeof startSessionApi>>, task: string): Promise<string> {
  const until = Date.now() + 20_000;
  for (;;) {
    const id = daemon.facade.agents.sessions().sessions.find((s) => s.task === task)?.id;
    if (id !== undefined) return id;
    if (Date.now() > until) throw new Error(`gave up waiting for a session of task ${task}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.versions.bun === undefined)("sessions across a daemon restart (real PTY and git, fake Copilot CLI)", () => {
  test("the sessions that ran when the daemon stopped start again in the next one, with their conversations", async () => {
    const before = await startDaemon();
    const { agents } = before.facade;
    const main = await agents.start("shop");
    await waitFor(agents, main.id, (s) => s.state?.state === "Input", "sessionStart");
    // The fake starts a turn on the first prompt and asks for approval in it: the session now has a conversation.
    const window = viewer(agents, main.id);
    window.attachment.input("start\r");
    await waitFor(agents, main.id, (s) => s.state?.state === "Approval", "the approval request");
    window.attachment.detach();
    const supervisor = await agents.startSupervisor("new");
    const task = await agents.createTask("shop", "fix the build");
    const taskSession = agents.sessions().sessions.find((s) => s.task === task.id)?.id;
    if (taskSession === undefined) throw new Error(`task ${task.id} has no session`);
    await waitFor(agents, supervisor.id, (s) => s.state !== null, "the supervisor's input box");
    await waitFor(agents, taskSession, (s) => s.state !== null, "the task session's state");

    await stopDaemon(before);
    const after = await startDaemon({ home: before.home, projects: before.projects });

    // A main session and the supervisor under the same ids; a task's session is a new one of the same task.
    expect(await argumentOnScreen(after, main.id, "--resume=")).toContain(`Argument: --resume=${main.id}`);
    expect(after.facade.agents.session(main.id)).toMatchObject({ repo: "shop", task: null, run: { kind: "running" } });
    // The supervisor never had a prompt, so Copilot CLI keeps no conversation of it: it starts anew under its id.
    const supervisorScreen = await argumentOnScreen(after, supervisor.id, "--session-id=");
    expect(supervisorScreen).toContain(`Argument: --session-id=${supervisor.id}`);
    expect(supervisorScreen).not.toContain("--resume=");
    expect(after.facade.agents.session(supervisor.id)).toMatchObject({ repo: null, run: { kind: "running" } });
    const resumedTask = await resumedSessionOf(after, task.id);
    expect(await argumentOnScreen(after, resumedTask, "--resume=")).toContain(`Argument: --resume=${task.id}`);
  }, 60_000);

  test("a session the user stopped is not started again", async () => {
    const before = await startDaemon();
    const { agents } = before.facade;
    const stopped = await agents.start("shop");
    const running = await agents.start("shop");
    await waitFor(agents, running.id, (s) => s.state !== null, "the input box");
    await agents.stop(stopped.id);
    // The list follows the running sessions at every check, so the stop reaches it before the daemon stops.
    await waitFor(
      agents,
      running.id,
      () => {
        const file = join(before.home, RESUMABLE_FILE);
        return existsSync(file) && readFileSync(file, "utf8").includes(running.id) && !readFileSync(file, "utf8").includes(stopped.id);
      },
      "the stopped session out of the list",
    );

    await stopDaemon(before);
    const after = await startDaemon({ home: before.home, projects: before.projects });

    await waitFor(after.facade.agents, running.id, (s) => s.run.kind === "running", "the running session started again");
    expect(after.facade.agents.sessions().sessions.map((s) => s.id)).toEqual([running.id]);
  }, 60_000);

  test("a session that cannot start again goes to the log, and the others start", async () => {
    const before = await startDaemon();
    await stopDaemon(before);
    const [inGoneRepo, ofEndedTask, main] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const endedTask = crypto.randomUUID();
    const sessions = [
      { session: inGoneRepo, repo: "gone", task: null, hasConversation: true },
      { session: ofEndedTask, repo: "shop", task: endedTask, hasConversation: true },
      { session: main, repo: "shop", task: null, hasConversation: false },
    ];
    writeFileSync(join(before.home, RESUMABLE_FILE), JSON.stringify({ sessions }));
    const log: string[] = [];

    const after = await startSessionApi(TOKEN, {
      repos: {},
      miseCommand: ["mise"],
      restartOf: { home: before.home, projects: before.projects },
      log: (msg) => log.push(msg),
    });
    daemons.push(after);

    expect(await argumentOnScreen(after, main, "--session-id=")).toContain(`Argument: --session-id=${main}`);
    expect(after.facade.agents.sessions().sessions.map((s) => s.id)).toEqual([main]);
    expect(log.find((line) => line.startsWith(`resuming session ${inGoneRepo}:`))).toContain("gone");
    expect(log.find((line) => line.startsWith(`resuming session ${ofEndedTask}:`))).toContain(endedTask);
  }, 60_000);

  test("a broken list of sessions is moved aside and the next daemon starts without resuming any", async () => {
    const before = await startDaemon();
    await stopDaemon(before);
    writeFileSync(join(before.home, RESUMABLE_FILE), '{"sessions": [{"session": "../outside"}]}');

    const after = await startDaemon({ home: before.home, projects: before.projects });

    expect(after.facade.agents.sessions().sessions).toEqual([]);
    expect(existsSync(join(before.home, RESUMABLE_FILE))).toBe(false);
    expect(readdirSync(before.home).filter((name) => name.startsWith(`${RESUMABLE_FILE}.broken-`))).toHaveLength(1);
  });
});

describe.skipIf(process.versions.bun === undefined)("the supervisor's last conversation (real PTY, fake Copilot CLI, ADR-96)", () => {
  test("Resume goes on with the ended supervisor's conversation under its id, New starts another one", async () => {
    const daemon = await startDaemon();
    const { agents } = daemon.facade;
    const first = await agents.startSupervisor("new");
    await waitFor(agents, first.id, (s) => s.state?.state === "Input", "sessionStart");
    expect(agents.sessions().lastSupervisor).toBeNull();
    const window = viewer(agents, first.id);
    window.attachment.input("start\r");
    await waitFor(agents, first.id, () => agents.sessions().lastSupervisor === first.id, "the supervisor's conversation");
    window.attachment.detach();
    await agents.stop(first.id);

    const resumed = await agents.startSupervisor("last");

    expect(resumed.id).toBe(first.id);
    expect(await argumentOnScreen(daemon, first.id, "--resume=")).toContain(`Argument: --resume=${first.id}`);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([first.id]);
    await agents.stop(first.id);
    const fresh = await agents.startSupervisor("new");
    expect(fresh.id).not.toBe(first.id);
    expect(await argumentOnScreen(daemon, fresh.id, "--session-id=")).toContain(`Argument: --session-id=${fresh.id}`);
    expect(agents.sessions().sessions.map((s) => s.id)).toEqual([fresh.id]);
    // The newest supervisor has had no prompt yet, so there is no conversation to go on with.
    await waitFor(agents, fresh.id, () => agents.sessions().lastSupervisor === null, "no conversation to resume");
  }, 60_000);

  test("the conversation of a supervisor the user stopped and closed goes on after the daemon restarts", async () => {
    const before = await startDaemon();
    const { agents } = before.facade;
    const supervisor = await agents.startSupervisor("new");
    await waitFor(agents, supervisor.id, (s) => s.state?.state === "Input", "sessionStart");
    const window = viewer(agents, supervisor.id);
    window.attachment.input("start\r");
    await waitFor(agents, supervisor.id, () => agents.sessions().lastSupervisor === supervisor.id, "the supervisor's conversation");
    window.attachment.detach();
    await agents.stop(supervisor.id);
    agents.dismiss(supervisor.id);
    await stopDaemon(before);

    const after = await startDaemon({ home: before.home, projects: before.projects });

    // A supervisor the user stopped does not start again by itself, but its conversation is there to resume.
    expect(after.facade.agents.sessions()).toMatchObject({ sessions: [], lastSupervisor: supervisor.id });
    const resumed = await after.facade.agents.startSupervisor("last");
    expect(resumed.id).toBe(supervisor.id);
    expect(await argumentOnScreen(after, supervisor.id, "--resume=")).toContain(`Argument: --resume=${supervisor.id}`);
  }, 60_000);

  test("without a supervisor before, Resume starts a new one", async () => {
    const daemon = await startDaemon();

    const supervisor = await daemon.facade.agents.startSupervisor("last");

    expect(await argumentOnScreen(daemon, supervisor.id, "--session-id=")).toContain(`Argument: --session-id=${supervisor.id}`);
    expect(daemon.facade.agents.sessions().sessions.map((s) => s.id)).toEqual([supervisor.id]);
  }, 60_000);
});

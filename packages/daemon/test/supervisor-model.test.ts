import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationEntry } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import type { Agents } from "../src/modules/agents/agents.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";

// The supervisor runs on `supervisorModel` from the workspace (ADR-193), read at each start, so a change in Settings
// applies to its next start, resume or restart; without the key it runs on Copilot CLI's default.

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function startAgents(supervisorModel: () => string | null) {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const made = makeAgents(
    {},
    undefined,
    projects,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisorModel,
  );
  cleanups.push(() => made.procs.stopAll());
  return made;
}

/** The fake Copilot CLI's screen once it printed its arguments, the last one starting with `last`. */
async function argumentsOf(agents: Agents, session: string, last: string): Promise<string> {
  const window = viewer(agents, session);
  await waitFor(agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window.text();
}

/** The first answer of the agent in the session's conversation. */
async function firstAnswer(agents: Agents, session: string): Promise<string> {
  let entries: ConversationEntry[] = [];
  const window = agents.attachConversation(session, {
    send: (message) => {
      entries = message.reset ? [...message.entries] : [...entries, ...message.entries];
    },
    closed: () => {},
  });
  const deadline = Date.now() + 20_000;
  let answer = entries.find((e) => e.kind === "agent");
  while (answer === undefined) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for the answer: ${JSON.stringify(entries)}`);
    await new Promise((r) => setTimeout(r, 20));
    answer = entries.find((e) => e.kind === "agent");
  }
  window.detach();
  return answer.kind === "agent" ? answer.text : "";
}

describe.skipIf(process.versions.bun === undefined)("the supervisor's model (real PTY, fake Copilot CLI)", () => {
  test("the supervisor starts on the model from the workspace and a restart takes the model saved since", async () => {
    let model: string | null = "gpt-5-mini";
    const { agents } = startAgents(() => model);

    // With a first message, so Copilot CLI keeps a conversation the restart resumes.
    const supervisor = await agents.startSupervisorWith("plan my day", "terminal");

    expect(await argumentsOf(agents, supervisor.id, "--interactive=")).toContain("Argument: --model=gpt-5-mini");
    await waitFor(agents, supervisor.id, (s) => s.state !== null, "sessionStart");
    model = "claude-sonnet-5.5";
    await agents.restart(supervisor.id);
    const resumed = await argumentsOf(agents, supervisor.id, "--resume=");
    expect(resumed).toContain("Argument: --model=claude-sonnet-5.5");
    expect(resumed).not.toContain("--model=gpt-5-mini");
  }, 60_000);

  test("without a model in the workspace the supervisor runs on Copilot CLI's default", async () => {
    const { agents } = startAgents(() => null);

    const supervisor = await agents.startSupervisor("new", "terminal");

    expect(await argumentsOf(agents, supervisor.id, "--session-id=")).not.toContain("--model=");
  }, 60_000);

  test("the supervisor in the conversation view runs on the model from the workspace too", async () => {
    const { agents } = startAgents(() => "gpt-5-mini");

    const supervisor = await agents.startSupervisorWith("plan my day", "conversation");

    const asking = await waitFor(agents, supervisor.id, (s) => s.dialog !== null, "the approval request");
    agents.answerDialog(supervisor.id, asking.dialog?.id ?? "", "1");
    expect(await firstAnswer(agents, supervisor.id)).toContain("Argument: --model=gpt-5-mini");
  }, 60_000);

  test("a bad model in the workspace refuses the supervisor's restart before it stops, so it goes on running", async () => {
    let broken = false;
    const { agents } = startAgents(() => {
      if (broken) throw new DomainError("invalid_config", "supervisorModel: a model id is letters, digits, dots, dashes and underscores");
      return null;
    });
    const supervisor = await agents.startSupervisor("new", "terminal");
    await waitFor(agents, supervisor.id, (s) => s.state !== null, "sessionStart");

    broken = true;

    await expect(agents.restart(supervisor.id)).rejects.toMatchObject({ code: "invalid_config" });
    expect(agents.session(supervisor.id).run.kind).toBe("running");
  }, 60_000);
});

describe.skipIf(process.versions.bun === undefined)("the supervisor's model in Settings (real facade, fake Copilot CLI)", () => {
  test("a model saved in Settings goes into workspace.yaml and the supervisor's next start runs on it; clearing it removes the key", async () => {
    const daemon = await startSessionApi("f".repeat(43));
    cleanups.push(() => daemon.stop());
    const { agents, workspace } = daemon.facade;
    const file = join(daemon.home, "workspace.yaml");

    expect(workspace.setSupervisorModel("gpt-5-mini")).toMatchObject({ supervisorModel: "gpt-5-mini", supervisorModelProblem: null });
    expect(readFileSync(file, "utf8")).toContain("supervisorModel: gpt-5-mini");
    const supervisor = await agents.startSupervisor("new", "terminal");
    expect(await argumentsOf(agents, supervisor.id, "--session-id=")).toContain("Argument: --model=gpt-5-mini");
    await agents.stop(supervisor.id);

    expect(workspace.setSupervisorModel(null)).toMatchObject({ supervisorModel: null, supervisorModelProblem: null });
    expect(readFileSync(file, "utf8")).not.toContain("supervisorModel");
  }, 60_000);

  test("a model written wrong by hand stops the supervisor's start and Settings says why", async () => {
    const daemon = await startSessionApi("g".repeat(43));
    cleanups.push(() => daemon.stop());
    const file = join(daemon.home, "workspace.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}supervisorModel: "gpt 5; rm -rf"\n`);

    await expect(daemon.facade.agents.startSupervisor("new", "terminal")).rejects.toMatchObject({ code: "invalid_config" });
    expect(daemon.facade.workspace.settings()).toMatchObject({
      supervisorModel: null,
      supervisorModelProblem: expect.stringContaining("a model id is letters"),
    });
  }, 60_000);
});

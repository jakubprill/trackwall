import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentsApi, taskRoundsApi } from "@trackwall/protocol";
import { waitFor } from "../test/support/agents.ts";
import { gitIn } from "../test/support/git-repo.ts";
import { hookRecords, startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ModelRequest, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// What a change in one session (ADR-265) relies on from the real Copilot CLI (ADR-67): in a folder that is no repo and
// holds a git worktree per repo, Copilot CLI works on the files of every worktree as inside its own folder, with no
// request for access to another path, loads the session instructions and records the folder for the usage report.

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;

/** How long a session may take to start and to finish a turn: a cold ~170 MB binary that Windows Defender scans. */
const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model, {
    repos: { payments: { "README.md": "# payments\n" }, "orders-api": { "README.md": "# orders-api\n" } },
  });
  // Round commits carry the user's own identity, which git takes from the repo's config here.
  for (const repo of ["payments", "orders-api"]) {
    gitIn(join(daemon.projects, repo), "config", "user.name", "Repo User");
    gitIn(join(daemon.projects, repo), "config", "user.email", "user@example.com");
  }
});

afterEach(() => {
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

afterAll(async () => {
  await daemon.stop();
  await model.close();
});

/** The shell tool Copilot CLI gives the model: `powershell` on Windows, `bash` elsewhere. */
function shellCall(request: ModelRequest, command: { bash: string; powershell: string }) {
  const tool = request.tools.includes("powershell") ? "powershell" : "bash";
  return { tool, arguments: { command: command[tool], description: "Create a file in each repo" } };
}

describe("a change in one session with the real Copilot CLI (ADR-265)", () => {
  test("the one session works in the change's folder on every part's worktree without asking for another path, and each part gets its round commit", async () => {
    model.reply(
      (request) =>
        shellCall(request, {
          bash: "touch payments/refunds.txt orders-api/cancel.txt",
          powershell: "New-Item payments/refunds.txt; New-Item orders-api/cancel.txt",
        }),
      { text: "Created a file in each repo." },
    );
    const { tasks, failed } = await daemon.post(agentsApi.createChange, {
      title: "Refund API",
      prompt: "create a file in each repo",
      parts: [{ repo: "payments" }, { repo: "orders-api" }],
      approvals: "auto",
      sessions: "shared",
    });
    expect(failed).toEqual([]);
    const [payments, orders] = tasks;
    if (payments === undefined || orders === undefined) throw new Error("two parts expected");
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === payments.id);
    if (session === undefined) throw new Error("the lead part has no session");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.reason === "hook agentStop", "end of turn", SESSION_MS);

    // The prompt came as the first message, in the change's folder, with the role of the one session.
    const first = model.requests().find((r) => r.lastUserText.includes("create a file in each repo"));
    const folder = dirname(payments.worktree);
    // Copilot CLI names its working directory by the real path (macOS: /private/var/… for the temporary /var/…).
    expect(first?.system).toContain(realpathSync.native(folder));
    expect(first?.system).toContain("You run one change across 2 repos in this one session.");
    // The command wrote into both worktrees, and Copilot CLI asked for nothing: no approval, no access to another path.
    expect(existsSync(join(payments.worktree, "refunds.txt"))).toBe(true);
    expect(existsSync(join(orders.worktree, "cancel.txt"))).toBe(true);
    expect(hookRecords(daemon.home, session.id).map((r) => r.event)).not.toContain("notification");
    expect(daemon.facade.agents.session(session.id).dialog).toBeNull();

    // The end of the turn commits what it left in each part, on the part's own branch.
    for (const part of [payments, orders]) {
      const until = Date.now() + SESSION_MS;
      while ((await daemon.post(taskRoundsApi.rounds, { task: part.id })).rounds.length === 0) {
        if (Date.now() > until) throw new Error(`gave up waiting for round 1 of ${part.repo}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(gitIn(part.worktree, "log", "-1", "--format=%s").trim()).toBe("WIP round 1");
    }

    // Copilot CLI records the folder, which is no repo and has no branch: the usage report counts it for the lead part.
    const until = Date.now() + SESSION_MS;
    const row = async () => (await daemon.facade.usageReport.week(0)).work.find((w) => w.task === payments.id);
    while ((await row()) === undefined) {
      if (Date.now() > until) throw new Error("the change's conversation never showed in the report");
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await row()).toMatchObject({ kind: "task", repo: "payments", conversations: 1 });

    await daemon.facade.agents.stop(session.id);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "e".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const FAKE_COPILOT = [process.execPath, join(import.meta.dir, "fixtures", "fake-copilot-session.ts")];

/** What mise gives in the repo root of `shop` (`fake-mise.json`, committed, so a task's worktree has it too). */
const SHOP_MISE = {
  tasks: [],
  env: { GITLAB_TOKEN: "glpat-repo-root-value", JIRA_KEY: "jira-key-from-age", MAVEN_OPTS: "-Xmx2g", SHOP_REGION: "repo-root" },
  redacted: ["GITLAB_TOKEN", "JIRA_KEY"],
};

let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n", "fake-mise.json": JSON.stringify(SHOP_MISE) } },
    miseCommand: FAKE_MISE,
    copilot: {
      command: FAKE_COPILOT,
      env: () => ({ ...process.env, FAKE_COPILOT_SHOW_ENV: "GITLAB_TOKEN,JIRA_KEY,SHOP_REGION,MAVEN_OPTS" }),
    },
  });
});

afterAll(async () => {
  await daemon.stop();
});

function runningSessionOf(task: string): Session {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session;
}

/** `workspace.yaml` with the projects folder and the given lines after it. */
function workspace(lines = ""): void {
  writeFileSync(join(daemon.home, "workspace.yaml"), `projectsDir: ${JSON.stringify(daemon.projects)}\n${lines}`);
}

/** The projects folder's own mise config: the `[env]` of `Dev/mise.toml` in the user's words. */
function projectsMise(config: object): void {
  writeFileSync(join(daemon.projects, "fake-mise.json"), JSON.stringify({ tasks: [], ...config }));
}

describe.skipIf(process.versions.bun === undefined)(
  "a session's environment from mise (ADR-93; real PTY and git, fake mise and Copilot CLI)",
  () => {
    test("a session in a repo root gets its mise variables, its tools only the secrets in agentSecrets, and the daemon masks them all", async () => {
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace("agentSecrets: [JIRA_KEY]\n");
      const started = await daemon.facade.agents.start("shop");
      const window = viewer(daemon.facade.agents, started.id);
      await waitFor(daemon.facade.agents, started.id, () => window.text().includes("Env MAVEN_OPTS"), "the environment on the screen");

      // `JIRA_KEY` is a secret only because mise redacts it (an age value), `GITLAB_TOKEN` also by its name.
      expect(window.text()).toContain("Argument: --secret-env-vars=GITLAB_TOKEN\r");
      expect(window.text()).toContain("Env GITLAB_TOKEN=(hidden)");
      expect(window.text()).toContain("Env JIRA_KEY=jira-key-from-age");
      expect(window.text()).toContain("Env MAVEN_OPTS=-Xmx2g");
      expect(started.environment).toEqual({
        variables: ["GITLAB_TOKEN", "JIRA_KEY", "MAVEN_OPTS", "SHOP_REGION"],
        secrets: ["GITLAB_TOKEN", "JIRA_KEY"],
        agentSecrets: ["JIRA_KEY"],
        problem: null,
      });
      window.attachment.detach();

      await daemon.facade.agents.stop(started.id);
      const ended = daemon.facade.agents.session(started.id).run;
      if (ended.kind !== "exited") throw new Error(`the session did not end: ${ended.kind}`);
      const lastLines = ended.lastLines.join("\n");
      expect(lastLines).toContain("Env MAVEN_OPTS=-Xmx2g");
      expect(lastLines).toContain("Env JIRA_KEY=***");
      expect(lastLines).not.toContain("jira-key-from-age");
    }, 60_000);

    test("without agentSecrets every secret is hidden from the session's tools", async () => {
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const started = await daemon.facade.agents.start("shop");
      const window = viewer(daemon.facade.agents, started.id);
      await waitFor(daemon.facade.agents, started.id, () => window.text().includes("Env MAVEN_OPTS"), "the environment on the screen");

      expect(window.text()).toContain("Argument: --secret-env-vars=GITLAB_TOKEN,JIRA_KEY");
      expect(window.text()).toContain("Env GITLAB_TOKEN=(hidden)");
      expect(window.text()).toContain("Env JIRA_KEY=(hidden)");
      expect(started.environment.agentSecrets).toEqual([]);
      window.attachment.detach();
      await daemon.facade.agents.stop(started.id);
    }, 60_000);

    test("a session in a repo whose mise config is not trusted gets the projects folder's environment and says why", async () => {
      writeFileSync(join(daemon.projects, "shop", "fake-mise.json"), JSON.stringify({ ...SHOP_MISE, untrusted: true }));
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      try {
        const started = await daemon.facade.agents.start("shop");
        const window = viewer(daemon.facade.agents, started.id);
        await waitFor(daemon.facade.agents, started.id, () => window.text().includes("Env MAVEN_OPTS"), "the environment on the screen");

        expect(window.text()).toContain("Env SHOP_REGION=projects-folder");
        expect(window.text()).toContain("Env MAVEN_OPTS=(unset)");
        expect(started.environment.variables).toEqual(["SHOP_REGION"]);
        expect(started.environment.problem).toContain("the root of shop: mise ERROR Config files in");
        expect(started.environment.problem).toContain("The session has the environment of the projects folder.");
        window.attachment.detach();
        await daemon.facade.agents.stop(started.id);
      } finally {
        writeFileSync(join(daemon.projects, "shop", "fake-mise.json"), JSON.stringify(SHOP_MISE));
      }
    }, 60_000);

    test("a task's session gets its worktree's environment, and the repo root's once the agent changed the worktree's mise config", async () => {
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const task = await daemon.facade.agents.createTask("shop", "use the token");
      const first = runningSessionOf(task.id);
      const firstWindow = viewer(daemon.facade.agents, first.id);
      await waitFor(daemon.facade.agents, first.id, () => firstWindow.text().includes("Env MAVEN_OPTS"), "the environment on the screen");
      firstWindow.attachment.detach();
      await daemon.facade.agents.stop(first.id);

      // mise reads the worktree's own config (here what the fake mise reads instead of `mise.toml`).
      writeFileSync(join(task.worktree, "fake-mise.json"), JSON.stringify({ ...SHOP_MISE, env: { SHOP_REGION: "worktree" } }));
      await daemon.facade.agents.resumeTask(task.id);
      const resumed = runningSessionOf(task.id);
      const window = viewer(daemon.facade.agents, resumed.id);
      await waitFor(daemon.facade.agents, resumed.id, () => window.text().includes("Env MAVEN_OPTS"), "the environment on the screen");
      expect(window.text()).toContain("Env SHOP_REGION=worktree");
      expect(resumed.environment.problem).toBeNull();
      window.attachment.detach();
      await daemon.facade.agents.stop(resumed.id);

      // A `mise.toml` the agent writes is a change to the worktree's mise config the user has not trusted (ADR-59).
      writeFileSync(join(task.worktree, "mise.toml"), '[env]\nSHOP_REGION = "from the agent"\n');
      await daemon.facade.agents.resumeTask(task.id);
      const again = runningSessionOf(task.id);
      const second = viewer(daemon.facade.agents, again.id);
      await waitFor(daemon.facade.agents, again.id, () => second.text().includes("Env MAVEN_OPTS"), "the environment on the screen");
      expect(second.text()).toContain("Env SHOP_REGION=repo-root");
      expect(again.environment.problem).toContain("mise.toml");
      expect(again.environment.problem).toContain("The session has the environment of the root of shop.");
      second.attachment.detach();
      await daemon.facade.agents.stop(again.id);
    }, 60_000);
  },
);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "e".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const FAKE_COPILOT = [process.execPath, join(import.meta.dir, "fixtures", "fake-copilot-session.ts")];

/** What mise gives in the repo root of `shop` (`fake-mise.json`, committed, so a task's worktree has it too). */
const SHOP_MISE = {
  tasks: [],
  env: { GITLAB_TOKEN: "glpat-repo-root-value", JIRA_KEY: "jira-key-from-age", SHOP_JAVA_OPTS: "-Xmx2g", SHOP_REGION: "repo-root" },
  redacted: ["GITLAB_TOKEN", "JIRA_KEY"],
};

let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n", "fake-mise.json": JSON.stringify(SHOP_MISE) } },
    miseCommand: FAKE_MISE,
    copilot: {
      command: FAKE_COPILOT,
      env: () => ({ ...process.env, FAKE_COPILOT_SHOW_ENV: "GITLAB_TOKEN,JIRA_KEY,SHOP_REGION,SHOP_JAVA_OPTS" }),
    },
  });
}, SLOW_TEST_TIMEOUT_MS);

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
      await waitFor(daemon.facade.agents, started.id, () => window.text().includes("Env SHOP_JAVA_OPTS"), "the environment on the screen");

      // `JIRA_KEY` is a secret only because mise redacts it (an age value), `GITLAB_TOKEN` also by its name.
      expect(window.text()).toContain("Argument: --secret-env-vars=GITLAB_TOKEN\r");
      expect(window.text()).toContain("Env GITLAB_TOKEN=(hidden)");
      expect(window.text()).toContain("Env JIRA_KEY=jira-key-from-age");
      expect(window.text()).toContain("Env SHOP_JAVA_OPTS=-Xmx2g");
      expect(started.environment).toEqual({
        variables: ["GITLAB_TOKEN", "JIRA_KEY", "SHOP_JAVA_OPTS", "SHOP_REGION"],
        secrets: ["GITLAB_TOKEN", "JIRA_KEY"],
        agentSecrets: ["JIRA_KEY"],
        profile: null,
        problem: null,
      });
      window.attachment.detach();

      await daemon.facade.agents.stop(started.id);
      const ended = daemon.facade.agents.session(started.id).run;
      if (ended.kind !== "exited") throw new Error(`the session did not end: ${ended.kind}`);
      const lastLines = ended.lastLines.join("\n");
      expect(lastLines).toContain("Env SHOP_JAVA_OPTS=-Xmx2g");
      expect(lastLines).toContain("Env JIRA_KEY=***");
      expect(lastLines).not.toContain("jira-key-from-age");
    }, 60_000);

    test("without agentSecrets every secret is hidden from the session's tools", async () => {
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const started = await daemon.facade.agents.start("shop");
      const window = viewer(daemon.facade.agents, started.id);
      await waitFor(daemon.facade.agents, started.id, () => window.text().includes("Env SHOP_JAVA_OPTS"), "the environment on the screen");

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
        await waitFor(
          daemon.facade.agents,
          started.id,
          () => window.text().includes("Env SHOP_JAVA_OPTS"),
          "the environment on the screen",
        );

        expect(window.text()).toContain("Env SHOP_REGION=projects-folder");
        expect(window.text()).toContain("Env SHOP_JAVA_OPTS=(unset)");
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
      await waitFor(
        daemon.facade.agents,
        first.id,
        () => firstWindow.text().includes("Env SHOP_JAVA_OPTS"),
        "the environment on the screen",
      );
      firstWindow.attachment.detach();
      await daemon.facade.agents.stop(first.id);

      // mise reads the worktree's own config (here what the fake mise reads instead of `mise.toml`).
      writeFileSync(join(task.worktree, "fake-mise.json"), JSON.stringify({ ...SHOP_MISE, env: { SHOP_REGION: "worktree" } }));
      await daemon.facade.agents.resumeTask(task.id);
      const resumed = runningSessionOf(task.id);
      const window = viewer(daemon.facade.agents, resumed.id);
      await waitFor(daemon.facade.agents, resumed.id, () => window.text().includes("Env SHOP_JAVA_OPTS"), "the environment on the screen");
      expect(window.text()).toContain("Env SHOP_REGION=worktree");
      expect(resumed.environment.problem).toBeNull();
      window.attachment.detach();
      await daemon.facade.agents.stop(resumed.id);

      // A `mise.toml` the agent writes is a change to the worktree's mise config the user has not trusted (ADR-59).
      writeFileSync(join(task.worktree, "mise.toml"), '[env]\nSHOP_REGION = "from the agent"\n');
      await daemon.facade.agents.resumeTask(task.id);
      const again = runningSessionOf(task.id);
      const second = viewer(daemon.facade.agents, again.id);
      await waitFor(daemon.facade.agents, again.id, () => second.text().includes("Env SHOP_JAVA_OPTS"), "the environment on the screen");
      expect(second.text()).toContain("Env SHOP_REGION=repo-root");
      expect(again.environment.problem).toContain("mise.toml");
      expect(again.environment.problem).toContain("The session has the environment of the root of shop.");
      second.attachment.detach();
      await daemon.facade.agents.stop(again.id);
    }, 60_000);

    test("a repo session tells when a new token in mise and a name added to agentSecrets change its environment, and a restart goes on with its conversation under the new one", async () => {
      const { agents } = daemon.facade;
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const started = await agents.start("shop", "use the token");
      await waitFor(agents, started.id, (s) => s.state !== null, "the first prompt");
      expect(await agents.environmentChange(started.id)).toEqual({ change: null });

      const shopMise = join(daemon.projects, "shop", "fake-mise.json");
      writeFileSync(
        shopMise,
        JSON.stringify({ ...SHOP_MISE, env: { ...SHOP_MISE.env, GITLAB_TOKEN: "glpat-new-value", SHOP_FLAG: "on" } }),
      );
      workspace("agentSecrets: [JIRA_KEY]\n");
      try {
        expect((await agents.environmentChange(started.id)).change).toEqual({
          added: ["SHOP_FLAG"],
          removed: [],
          changed: ["GITLAB_TOKEN"],
          shared: ["JIRA_KEY"],
          unshared: [],
        });

        const restarted = await agents.restart(started.id);
        const window = viewer(agents, restarted.id);
        await waitFor(agents, restarted.id, () => window.text().includes("Env SHOP_JAVA_OPTS"), "the environment on the screen");

        expect(restarted.id).toBe(started.id);
        expect(window.text()).toContain(`Argument: --resume=${started.id}`);
        expect(window.text()).toContain("Env JIRA_KEY=jira-key-from-age");
        expect(restarted.environment.variables).toContain("SHOP_FLAG");
        expect(restarted.environment.agentSecrets).toEqual(["JIRA_KEY"]);
        expect(await agents.environmentChange(restarted.id)).toEqual({ change: null });
        window.attachment.detach();
        await agents.stop(restarted.id);
      } finally {
        writeFileSync(shopMise, JSON.stringify(SHOP_MISE));
      }
    }, 60_000);

    test("the supervisor, a free session and a task's session restart with their conversations and the environment of now", async () => {
      const { agents } = daemon.facade;
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const supervisor = await agents.startSupervisorWith("Start my day.", "terminal");
      const free = await agents.start(null, "Compare the two APIs");
      const task = await agents.createTask("shop", "use the token");
      const taskSession = runningSessionOf(task.id);
      for (const id of [supervisor.id, free.id, taskSession.id]) await waitFor(agents, id, (s) => s.state !== null, "the first prompt");

      projectsMise({ env: { SHOP_REGION: "projects-folder", DEV_TOKEN: "dev-token-value" } });
      workspace("agentSecrets: [JIRA_KEY]\n");
      const added = { added: ["DEV_TOKEN"], removed: [], changed: [], shared: [], unshared: [] };
      expect((await agents.environmentChange(supervisor.id)).change).toEqual(added);
      expect((await agents.environmentChange(free.id)).change).toEqual(added);
      expect((await agents.environmentChange(taskSession.id)).change).toEqual({ ...added, added: [], shared: ["JIRA_KEY"] });

      for (const [before, conversation] of [
        [supervisor, supervisor.id],
        [free, free.id],
        [taskSession, task.id],
      ] as const) {
        const after = await agents.restart(before.id);
        const window = viewer(agents, after.id);
        await waitFor(agents, after.id, () => window.text().includes(`Argument: --resume=${conversation}`), "the resumed conversation");

        expect(after).toMatchObject({ repo: before.repo, supervisor: before.supervisor, task: before.task });
        expect(await agents.environmentChange(after.id)).toEqual({ change: null });
        window.attachment.detach();
        await agents.stop(after.id);
      }
      expect(agents.sessions().sessions.filter((s) => s.task === task.id)).toHaveLength(1);
    }, 60_000);

    test("a second restart of a session while the first one runs is refused, and one session stays listed", async () => {
      const { agents } = daemon.facade;
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const started = await agents.start(null, "Compare the two APIs");
      await waitFor(agents, started.id, (s) => s.state !== null, "the first prompt");

      const [first, second] = await Promise.allSettled([agents.restart(started.id), agents.restart(started.id)]);

      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({ status: "rejected", reason: { code: "bad_request" } });
      const listed = agents.sessions().sessions.filter((s) => s.id === started.id);
      expect(listed.map((s) => s.run.kind)).toEqual(["running"]);
      await agents.stop(started.id);
    }, 60_000);

    test("a session profile chosen in Settings gives new sessions that mise environment, hides its key from the tools, and shows a running session a change to restart for", async () => {
      const { agents, workspace: settings } = daemon.facade;
      projectsMise({
        env: { SHOP_REGION: "projects-folder" },
        envByMiseEnv: {
          byok: { SHOP_REGION: "byok", COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:4000/v1", COPILOT_PROVIDER_API_KEY: "sk-local" },
        },
      });
      workspace();
      const before = await agents.start(null);
      await waitFor(agents, before.id, (s) => s.run.kind === "running", "the session running");
      expect(before.environment.profile).toBeNull();

      try {
        expect(settings.setSessionProfile("byok")).toMatchObject({ sessionProfile: "byok", sessionProfileProblem: null });
        expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).toContain("sessionProfile: byok");
        expect((await agents.environmentChange(before.id)).change).toEqual({
          added: ["COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BASE_URL"],
          removed: [],
          changed: ["SHOP_REGION"],
          shared: [],
          unshared: [],
        });

        const started = await agents.start(null);
        const window = viewer(agents, started.id);
        await waitFor(agents, started.id, () => window.text().includes("Env SHOP_REGION=byok"), "the profile's environment on the screen");
        expect(started.environment).toEqual({
          variables: ["COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BASE_URL", "SHOP_REGION"],
          secrets: ["COPILOT_PROVIDER_API_KEY"],
          agentSecrets: [],
          profile: "byok",
          problem: null,
        });
        expect(window.text()).toContain("Argument: --secret-env-vars=COPILOT_PROVIDER_API_KEY");
        window.attachment.detach();
        await agents.stop(started.id);
      } finally {
        settings.setSessionProfile(null);
      }
      expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).not.toContain("sessionProfile");
      await agents.stop(before.id);
    }, 60_000);

    test("a session does not start while the session profile in workspace.yaml is not a plain name", async () => {
      workspace("sessionProfile: ../secrets\n");
      try {
        await expect(daemon.facade.agents.start(null)).rejects.toMatchObject({ code: "invalid_config" });
        expect(daemon.facade.workspace.settings()).toMatchObject({
          sessionProfile: null,
          sessionProfileProblem: expect.stringContaining("a session profile is a name"),
        });
      } finally {
        workspace();
      }
    }, 60_000);

    test("a restart that the configuration refuses leaves the session running as it was", async () => {
      const { agents } = daemon.facade;
      projectsMise({ env: { SHOP_REGION: "projects-folder" } });
      workspace();
      const started = await agents.start("shop", "use the token");
      await waitFor(agents, started.id, (s) => s.state !== null, "the first prompt");
      workspace('agentSecrets: ["not a variable name"]\n');
      try {
        await expect(agents.restart(started.id)).rejects.toMatchObject({ code: "invalid_config" });
        expect(agents.session(started.id).run.kind).toBe("running");
      } finally {
        workspace();
      }
      await agents.stop(started.id);
    }, 60_000);

    test("an ended session is not restarted", async () => {
      const { agents } = daemon.facade;
      const started = await agents.start("shop");
      await agents.stop(started.id);

      await expect(agents.restart(started.id)).rejects.toMatchObject({ code: "bad_request" });
      expect(await agents.environmentChange(started.id)).toEqual({ change: null });
    }, 60_000);
  },
);

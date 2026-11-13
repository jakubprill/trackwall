import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi, taskRefreshApi, taskRoundsApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task's refresh from its base branch (ADR-245): the newest commits of the branch the task started from merged into the
// task branch, never rebased, with nothing changed when the merge would conflict. Each test has a repo of its own.

const TOKEN = "f".repeat(43);
const REPOS = ["shop", "web", "api", "docs", "cli", "lib"] as const;
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: Object.fromEntries(REPOS.map((name) => [name, { "README.md": `# ${name}\n` }])),
    miseCommand: ["mise"],
  });
  // The merge commit carries the user's own identity, which git takes from the repo's config here.
  for (const name of REPOS) {
    gitIn(repoDir(name), "config", "user.name", "Repo User");
    gitIn(repoDir(name), "config", "user.email", "user@example.com");
  }
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function repoDir(name: string): string {
  return join(daemon.projects, name);
}

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
const refresh = (task: string) => daemon.post(taskRefreshApi.refreshTask, { task });
const taskNow = (id: string) => daemon.facade.agents.task(id);

/**
 * A task whose session is stopped: the fake Copilot CLI stays in its first turn after the task's prompt, and a refresh is
 * refused in a turn, so the tests that are not about turns refresh a task the user stopped.
 */
async function stoppedTask(repo: string, prompt: string) {
  const task = await daemon.facade.agents.createTask(repo, prompt);
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
  if (session) await daemon.post(agentsApi.stop, { session: session.id });
  return task;
}

describe.skipIf(process.versions.bun === undefined)("refreshing a task from its base branch (real git, fake Copilot CLI)", () => {
  test("a task does not see work merged to main after it started until it is refreshed; the refresh merges it and the task's changes stay its own", async () => {
    const task = await stoppedTask("shop", "Add a cart");
    commitFiles(task.worktree, { "cart.ts": "export const cart = [];\n" }, "Add a cart");
    const taskHead = head(task.worktree);
    // Someone merges other work to main after the task started.
    commitFiles(repoDir("shop"), { "CHANGELOG.md": "Faster checkout\n" }, "Speed up the checkout");
    const main = head(repoDir("shop"));

    // Before: the task's worktree still has the old main, so the agent builds on code that is no longer current.
    expect(existsSync(join(task.worktree, "CHANGELOG.md"))).toBe(false);

    const refreshed = await refresh(task.id);

    expect(refreshed).toEqual({ state: "refreshed", from: "main", commits: 1, base: main });
    expect(readFileSync(join(task.worktree, "CHANGELOG.md"), "utf8")).toBe("Faster checkout\n");
    // A merge commit on top of the task's own history, which stays as it was: nothing to force push.
    expect(gitIn(task.worktree, "log", "-1", "--format=%P|%s|%an").trim()).toBe(
      `${taskHead} ${main}|Merge main into ${task.branch}|Repo User`,
    );
    expect(gitIn(task.worktree, "status", "--porcelain")).toBe("");
    // The new main is the task's base, so its changes are still only the cart.
    expect(taskNow(task.id).base).toBe(main);
    const changes = await daemon.post(agentsApi.taskChanges, { task: task.id });
    expect(changes.files.map((f) => f.path)).toEqual(["cart.ts"]);

    expect(await refresh(task.id)).toEqual({ state: "up-to-date", from: "main" });
  }, 60_000);

  test("a merge that would conflict changes nothing and names the files", async () => {
    const task = await stoppedTask("web", "Rename the site");
    commitFiles(task.worktree, { "README.md": "# web shop\n" }, "Rename the site");
    const taskHead = head(task.worktree);
    commitFiles(repoDir("web"), { "README.md": "# web store\n", LICENSE: "MIT\n" }, "Rename the site differently");

    expect(await refresh(task.id)).toEqual({ state: "conflicts", from: "main", commits: 1, files: ["README.md"] });

    expect(head(task.worktree)).toBe(taskHead);
    expect(readFileSync(join(task.worktree, "README.md"), "utf8")).toBe("# web shop\n");
    expect(existsSync(join(task.worktree, "LICENSE"))).toBe(false);
    expect(gitIn(task.worktree, "status", "--porcelain")).toBe("");
    expect(taskNow(task.id).base).toBe(task.base);
  }, 60_000);

  test("changes outside a commit are never mixed with a merge: the refresh is refused and says why", async () => {
    const task = await stoppedTask("api", "Add an endpoint");
    writeFileSync(join(task.worktree, "endpoint.ts"), "export const endpoint = 1;\n");
    commitFiles(repoDir("api"), { "CHANGELOG.md": "Later work\n" }, "Later work on main");

    await expect(refresh(task.id)).rejects.toThrow("the worktree has changes outside a commit");

    expect(head(task.worktree)).toBe(task.base);
    expect(existsSync(join(task.worktree, "CHANGELOG.md"))).toBe(false);
  }, 60_000);

  test("the refresh fetches the main remote and merges its branch when the local main is behind it", async () => {
    // An origin that gets a commit the local main never pulled.
    const remotes = mkdtempSync(join(tmpdir(), "trackwall-refresh-"));
    const origin = join(remotes, "docs.git");
    gitIn(remotes, "clone", "-q", "--bare", repoDir("docs"), origin);
    gitIn(repoDir("docs"), "remote", "add", "origin", origin);
    gitIn(repoDir("docs"), "fetch", "-q", "origin");
    gitIn(repoDir("docs"), "remote", "set-head", "origin", "main");
    const task = await stoppedTask("docs", "Write a guide");
    commitFiles(task.worktree, { "guide.md": "# Guide\n" }, "Write a guide");
    const colleague = join(remotes, "colleague");
    gitIn(remotes, "clone", "-q", origin, colleague);
    commitFiles(colleague, { "faq.md": "# FAQ\n" }, "Add a FAQ");
    gitIn(colleague, "push", "-q", "origin", "main");
    const pushed = head(colleague);
    expect(gitIn(repoDir("docs"), "rev-parse", "main").trim()).not.toBe(pushed);

    expect(await refresh(task.id)).toEqual({ state: "refreshed", from: "origin/main", commits: 1, base: pushed });

    expect(readFileSync(join(task.worktree, "faq.md"), "utf8")).toBe("# FAQ\n");
    // The user's own main checkout is left alone.
    expect(gitIn(repoDir("docs"), "rev-parse", "main").trim()).not.toBe(pushed);
  }, 60_000);

  test("the merge runs no merge driver an agent could write into the repo's config", async () => {
    const lines = "one\ntwo\nthree\nfour\nfive\n";
    commitFiles(repoDir("lib"), { "list.txt": lines, ".gitattributes": "list.txt merge=agent\n" }, "Add a list");
    const task = await stoppedTask("lib", "Change the list");
    // A merge driver in the repo's config, as an agent outside the sandbox could add it, that would leave a mark when run.
    const marker = join(mkdtempSync(join(tmpdir(), "trackwall-driver-")), "driver-ran");
    gitIn(
      repoDir("lib"),
      "config",
      "merge.agent.driver",
      `node -e "require('fs').writeFileSync(process.argv[1], '')" ${JSON.stringify(marker)}`,
    );
    commitFiles(task.worktree, { "list.txt": lines.replace("one", "ONE") }, "Shout the first line");
    commitFiles(repoDir("lib"), { "list.txt": lines.replace("five", "FIVE") }, "Shout the last line");

    expect(await refresh(task.id)).toMatchObject({ state: "refreshed" });

    expect(readFileSync(join(task.worktree, "list.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("refused in the middle of a turn; afterwards the round commits are squashed before the merge and the agent is told", async () => {
    const task = await daemon.facade.agents.createTask("cli", "Add a flag");
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error(`task ${task.id} has no session`);
    const terminal = viewer(daemon.facade.agents, session.id);
    terminal.attachment.input("start\r");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the first turn's approval");
    // The turn's start is read in the background after its hook; the rounds come back after it (as in task-rounds.test.ts).
    await daemon.post(taskRoundsApi.rounds, { task: task.id });
    commitFiles(repoDir("cli"), { "CHANGELOG.md": "Later work\n" }, "Later work on main");
    const main = head(repoDir("cli"));

    await expect(refresh(task.id)).rejects.toThrow("the agent is in the middle of a turn: refresh once it waits for you");

    // The agent leaves its work uncommitted; the end of the turn makes it a round commit.
    writeFileSync(join(task.worktree, "flag.ts"), "export const flag = true;\n");
    terminal.attachment.input("1");
    await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Input", "the end of the turn");
    const rounds = await daemon.post(taskRoundsApi.rounds, { task: task.id });
    expect(rounds.rounds.length).toBe(1);
    expect(gitIn(task.worktree, "log", "-1", "--format=%s").trim()).toBe("WIP round 1");

    expect(await refresh(task.id)).toMatchObject({ state: "refreshed", commits: 1, base: main });

    // The round commit became the task's own commit under its prompt, below the merge, where the push's squash would no longer reach it.
    expect(gitIn(task.worktree, "log", "--first-parent", "--format=%s", `${task.base}..HEAD`).trim().split("\n")).toEqual([
      `Merge main into ${task.branch}`,
      "Add a flag",
    ]);
    expect(readFileSync(join(task.worktree, "flag.ts"), "utf8")).toBe("export const flag = true;\n");
    await waitFor(
      daemon.facade.agents,
      session.id,
      () => terminal.unwrappedText().includes("Thinking about: The user merged the newest commits of your task's base branch"),
      "the typed refresh prompt",
    );
  }, 60_000);
});

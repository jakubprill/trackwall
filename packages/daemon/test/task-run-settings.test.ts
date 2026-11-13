import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { agentsApi } from "@trackwall/protocol";
import { countedEntries } from "../src/modules/vcs/run-settings.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { sandboxProgramsFolder } from "./support/sandbox-programs.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task in Copilot CLI's sandbox can still write the repo's `.git`, so the daemon guards the settings there that make
// git run a program (ADR-181 addendum, `run-settings.ts`): a clean filter written into `.git/config` would otherwise run
// on the daemon's next read of the task's changes, outside the sandbox.

const TOKEN = "r".repeat(43);
/** The clean filter tees the file's content into this file in the worktree, so its run leaves a trace. */
const TRACE = "ran-by-the-filter.txt";

let daemon: Awaited<ReturnType<typeof startSessionApi>> | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
}, 30_000);

function sandboxed(sandboxTasks: "all" | "off") {
  const path = `${sandboxProgramsFolder()}${delimiter}${process.env.PATH ?? ""}`;
  return startSessionApi(TOKEN, {
    ...ONE_REPO,
    sandboxTasks,
    copilot: { command: FAKE_COPILOT.command, env: () => ({ ...process.env, PATH: path }) },
  });
}

/** What the agent can do from the sandbox: a filter in the repo's own config and an attribute in the worktree. */
function writeFilter(repoDir: string, worktree: string): void {
  execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", `tee ${TRACE}`]);
  writeFileSync(join(worktree, ".gitattributes"), "*.md filter=trace\n");
  writeFileSync(join(worktree, "README.md"), "# shop, changed\n");
}

describe.skipIf(process.versions.bun === undefined)(
  "the run settings of a repo with a task in the sandbox (real git, fake Copilot CLI)",
  () => {
    test(
      "without the sandbox the daemon's read of a task's changes runs a filter written into .git/config, which is the gap the guard closes",
      async () => {
        daemon = await sandboxed("off");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        expect(task.sandbox).toBe(false);
        writeFilter(join(daemon.projects, "shop"), task.worktree);

        await daemon.facade.agents.taskChanges(task.id);

        expect(existsSync(join(task.worktree, TRACE))).toBe(true);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "with a task in the sandbox git in the repo is refused once a filter is written into .git/config, also by a restarted daemon, until the change is undone",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        expect(task.sandbox).toBe(true);
        await daemon.facade.agents.taskChanges(task.id);
        writeFilter(repoDir, task.worktree);

        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
        await expect(new Vcs(systemTempFolder).status(repoDir, "fresh")).rejects.toThrow("changed since a task in the sandbox started");
        expect(existsSync(join(task.worktree, TRACE))).toBe(false);

        const dirs = { home: daemon.home, projects: daemon.projects };
        await daemon.stop();
        daemon = await startSessionApi(TOKEN, { ...ONE_REPO, restartOf: dirs, copilot: FAKE_COPILOT });
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");

        execFileSync("git", ["-C", repoDir, "config", "--unset", "filter.trace.clean"]);
        expect((await daemon.facade.agents.taskChanges(task.id)).files.map((f) => f.path)).toContain("README.md");
        expect(existsSync(join(task.worktree, TRACE))).toBe(false);
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "a task's worktree whose .git the agent points at a git directory of its own is refused, and so is a config rewritten in place with its old times",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", "cat -u"]);
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        await daemon.facade.agents.taskChanges(task.id);

        // The same size and modification time, as an agent's write followed by `touch -d` leaves it.
        const config = join(repoDir, ".git", "config");
        const before = statSync(config);
        writeFileSync(config, readFileSync(config, "utf8").replace("cat -u", `tee ${TRACE.slice(0, 2)}`));
        utimesSync(config, before.atime, before.mtime);
        expect(statSync(config).size).toBe(before.size);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
        execFileSync("git", ["-C", repoDir, "config", "filter.trace.clean", "cat -u"]);
        await daemon.facade.agents.taskChanges(task.id);

        // A git directory of the agent's own, inside the worktree it can write.
        const own = join(task.worktree, "own-git");
        execFileSync("git", ["init", "--quiet", "--bare", own]);
        writeFileSync(join(task.worktree, ".git"), `gitdir: ${own}\n`);
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("no longer leads to its repo's git directory");
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "settings git writes in ordinary work, husky's hooks path and a second task's worktree do not refuse git, while a new hook does",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://example.com/shop.git"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.remote", "origin"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.merge", "refs/heads/main"]);
        execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", ".husky"]);
        execFileSync("git", ["-C", repoDir, "config", "lfs.repositoryformatversion", "0"]);
        await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "list the tests", approvals: "auto" });

        await daemon.facade.agents.taskChanges(task.id);

        writeFileSync(join(repoDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
        await expect(daemon.facade.agents.taskChanges(task.id)).rejects.toThrow("changed since a task in the sandbox started");
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  },
);

describe("the entries of a repo configuration that count as run settings", () => {
  test("keys with which git runs a program or reads another file count, in their order, and the rest is left out", () => {
    const list = [
      "core.bare\nfalse",
      "core.filemode\ntrue",
      "remote.origin.url\nhttps://example.com/shop.git",
      "remote.origin.uploadpack\nsh -c id",
      "branch.main.remote\norigin",
      "branch.main.vscode-merge-base\norigin/main",
      "lfs.https://example.com/shop.git/info/lfs.access\nbasic",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
      "include.path\n../shared.gitconfig",
      "core.hookspath\n.husky",
      "core.hookspath\n../elsewhere",
      "core.hookspath\n/tmp/hooks",
      "",
    ].join("\0");

    expect(countedEntries(list)).toEqual([
      "core.bare\nfalse",
      "remote.origin.uploadpack\nsh -c id",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
      "include.path\n../shared.gitconfig",
      "core.hookspath\n../elsewhere",
      "core.hookspath\n/tmp/hooks",
    ]);
  });
});

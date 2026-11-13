import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
      "settings git writes in ordinary work and a second task's worktree do not refuse git, while a new hook does",
      async () => {
        daemon = await sandboxed("all");
        const repoDir = join(daemon.projects, "shop");
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://example.com/shop.git"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.remote", "origin"]);
        execFileSync("git", ["-C", repoDir, "config", "branch.main.merge", "refs/heads/main"]);
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
  test("keys git writes in ordinary work are left out, and everything else counts, in its order", () => {
    const list = [
      "core.bare\nfalse",
      "remote.origin.url\nhttps://example.com/shop.git",
      "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*",
      "remote.origin.uploadpack\nsh -c id",
      "branch.main.remote\norigin",
      "user.email\nme@example.com",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
      "",
    ].join("\0");

    expect(countedEntries(list)).toEqual([
      "core.bare\nfalse",
      "remote.origin.uploadpack\nsh -c id",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "core.fsmonitor\n./watch",
    ]);
  });
});

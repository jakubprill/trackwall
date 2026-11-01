import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { parseUnpushedLog } from "../src/modules/vcs/unpushed.ts";
import { parseWorktreeList } from "../src/modules/vcs/worktree-list.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

/** A facade on a fresh state folder and, unless `withFolder` is false, projects folder, in a container or not (ADR-162). */
async function facadeWith(inContainer: boolean, withFolder = true) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-unpushed-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-unpushed-projects-"));
  const facade = createFacade({
    inContainer,
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => process.env,
    log: () => {},
  });
  if (withFolder) await facade.workspace.setProjectsDir(projects);
  return { facade, projects };
}

/** A repo in `projects` with `main` pushed to a bare remote outside the projects folder and tracking it. */
function pushedRepo(projects: string, name: string): string {
  const dir = makeRepo({ "README.md": "# repo\n" }, name, projects);
  const remote = join(mkdtempSync(join(tmpdir(), "trackwall-unpushed-remote-")), `${name}.git`);
  gitIn(dir, "init", "-q", "--bare", remote);
  gitIn(dir, "remote", "add", "origin", remote);
  gitIn(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}

describe("unpushed work in a container (ADR-162)", () => {
  test(
    "commits ahead, a branch never pushed, a stash and a changed task worktree are counted; a pushed repo is left out",
    async () => {
      const { facade, projects } = await facadeWith(true);
      pushedRepo(projects, "clean");
      const api = pushedRepo(projects, "api");
      commitFiles(api, { "a.txt": "1" }, "ahead of origin");
      gitIn(api, "switch", "-q", "-c", "feature");
      commitFiles(api, { "b.txt": "1" }, "only on feature");
      commitFiles(api, { "c.txt": "1" }, "also only on feature");
      gitIn(api, "switch", "-q", "main");
      writeFileSync(join(api, "README.md"), "# stashed\n");
      gitIn(api, "stash", "-q");
      const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-unpushed-worktrees-")), "task");
      gitIn(api, "worktree", "add", "-q", "-b", "task-1", worktree, "origin/main");
      writeFileSync(join(worktree, "new.txt"), "draft\n");
      writeFileSync(join(worktree, "README.md"), "# changed\n");

      const work = await facade.workspace.unpushedWork();

      expect(work).toEqual({
        inContainer: true,
        repos: [{ repo: "api", commits: 3, branches: ["feature", "main"], noRemote: false, stashes: 1, changes: 2, changedWorktrees: 1 }],
        unreadable: [],
      });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a commit on the detached HEAD of a worktree counts, though no branch holds it",
    async () => {
      const { facade, projects } = await facadeWith(true);
      const api = pushedRepo(projects, "api");
      const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-unpushed-worktrees-")), "detached");
      gitIn(api, "worktree", "add", "-q", "--detach", worktree, "main");
      commitFiles(worktree, { "x.txt": "1" }, "on a detached HEAD");

      const work = await facade.workspace.unpushedWork();

      expect(work.repos).toEqual([{ repo: "api", commits: 1, branches: [], noRemote: false, stashes: 0, changes: 0, changedWorktrees: 0 }]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a repo without a remote counts every commit and says it has no remote",
    async () => {
      const { facade, projects } = await facadeWith(true);
      const notes = makeRepo({ "a.md": "1" }, "notes", projects);
      commitFiles(notes, { "b.md": "1" }, "second");

      const work = await facade.workspace.unpushedWork();

      expect(work.repos).toEqual([
        { repo: "notes", commits: 2, branches: ["main"], noRemote: true, stashes: 0, changes: 0, changedWorktrees: 0 },
      ]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a repo in the folder that is a worktree of another one is counted once, under the first name",
    async () => {
      const { facade, projects } = await facadeWith(true);
      const api = pushedRepo(projects, "api");
      gitIn(api, "worktree", "add", "-q", "-b", "fix", join(projects, "api-fix"), "main");
      commitFiles(join(projects, "api-fix"), { "fix.txt": "1" }, "a fix");

      const work = await facade.workspace.unpushedWork();

      expect(work.repos).toEqual([
        { repo: "api", commits: 1, branches: ["fix"], noRemote: false, stashes: 0, changes: 0, changedWorktrees: 0 },
      ]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a folder git cannot read is named as unreadable, and the other repos are still counted",
    async () => {
      const { facade, projects } = await facadeWith(true);
      const notes = makeRepo({ "a.md": "1" }, "notes", projects);
      writeFileSync(join(notes, "draft.md"), "x");
      mkdirSync(join(projects, "broken"));
      writeFileSync(join(projects, "broken", ".git"), "gitdir: /no/such/place\n");

      const work = await facade.workspace.unpushedWork();

      expect(work.unreadable.map((u) => u.repo)).toEqual(["broken"]);
      expect(work.unreadable[0]?.message).not.toBe("");
      expect(work.repos.map((r) => [r.repo, r.changes])).toEqual([["notes", 1]]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "outside a container nothing is read, however much is unpushed",
    async () => {
      const { facade, projects } = await facadeWith(false);
      makeRepo({ "a.md": "1" }, "notes", projects);

      expect(await facade.workspace.unpushedWork()).toEqual({ inContainer: false, repos: [], unreadable: [] });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the doctor warns with the totals in a container, says all is pushed when it is, and has no row outside one or without a projects folder",
    async () => {
      const inside = await facadeWith(true);
      const api = pushedRepo(inside.projects, "api");
      const pushed = await inside.facade.doctor.run();
      expect(pushed.checks.find((c) => c.id === "unpushed-work")).toEqual({
        id: "unpushed-work",
        status: "ok",
        summary: "Everything in the projects folder is pushed.",
        fix: null,
      });

      commitFiles(api, { "a.txt": "1" }, "ahead");
      writeFileSync(join(api, "draft.txt"), "x");
      const ahead = (await inside.facade.doctor.run()).checks.find((c) => c.id === "unpushed-work");
      expect(ahead?.status).toBe("warn");
      expect(ahead?.summary).toBe("Only in this container: 1 commit, 1 changed file in 1 repo.");
      expect(ahead?.fix).toContain("removing the volume or resetting Docker deletes it");

      const noFolder = await facadeWith(true, false);
      expect((await noFolder.facade.doctor.run()).checks.map((c) => c.id)).not.toContain("unpushed-work");

      const outside = await facadeWith(false);
      makeRepo({ "a.md": "1" }, "notes", outside.projects);
      expect((await outside.facade.doctor.run()).checks.map((c) => c.id)).not.toContain("unpushed-work");
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

describe("reading git's lists of worktrees and unpushed commits", () => {
  test("a worktree list gives each path with its HEAD and branch; a bare repo and a prunable worktree have nothing to read", () => {
    const out = [
      "worktree /repos/api",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/task 1",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "",
      "worktree /tmp/gone",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/old",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/repos/api", head: "1111111111111111111111111111111111111111", branch: "refs/heads/main", readable: true },
      { path: "/tmp/task 1", head: "2222222222222222222222222222222222222222", branch: null, readable: true },
      { path: "/tmp/gone", head: "3333333333333333333333333333333333333333", branch: "refs/heads/old", readable: false },
    ]);
  });

  test("a repo without commits lists its worktree with no HEAD", () => {
    expect(parseWorktreeList(["worktree /repos/new", `HEAD ${"0".repeat(40)}`, "branch refs/heads/main", ""].join("\n"))).toEqual([
      { path: "/repos/new", head: null, branch: "refs/heads/main", readable: true },
    ]);
  });

  test("one record per commit, with the branches named on the commits they point at, once each and sorted", () => {
    expect(parseUnpushedLog("feature\0\0task-1, main\0")).toEqual({ commits: 3, branches: ["feature", "main", "task-1"] });
    expect(parseUnpushedLog("")).toEqual({ commits: 0, branches: [] });
  });
});

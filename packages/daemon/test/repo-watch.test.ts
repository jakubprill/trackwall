import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import type { RepoEntry } from "../src/modules/workspace/projects-dir.ts";
import { RepoWatch } from "../src/modules/workspace/repo-watch.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** The repo watch on real git and a real projects folder; the test calls each comparison itself instead of a timer. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const vcs = new Vcs();
  const file = new WorkspaceFile(join(home, "workspace.yaml"));
  const workspace = new Workspace({ file, vcs, hosting: fakeHosting().hosting, openEditor: () => {}, openFolder: () => {} });
  await workspace.setProjectsDir(projects);
  const handed: string[][] = [];
  const logs: string[] = [];
  const watch = new RepoWatch({
    repos: workspace,
    vcs,
    onChanged: (repos: RepoEntry[]) => handed.push(repos.map((r) => r.id)),
    log: (msg) => logs.push(msg),
  });
  return { home, projects, vcs, file, watch, handed, logs };
}

describe("git state from the files of the git directory", () => {
  test("a commit, a new branch, a checkout and a ref from a fetch change the state, and git status does not", async () => {
    const vcs = new Vcs();
    const repo = makeRepo({ "a.txt": "1" });
    const states = [await vcs.gitState(repo)];

    gitIn(repo, "status");
    writeFileSync(join(repo, "a.txt"), "uncommitted");
    gitIn(repo, "status");
    expect((await vcs.gitState(repo))?.key).toBe(states[0]?.key);

    commitFiles(repo, { "a.txt": "2" }, "second");
    states.push(await vcs.gitState(repo));
    gitIn(repo, "branch", "feature/x");
    states.push(await vcs.gitState(repo));
    gitIn(repo, "checkout", "-q", "feature/x");
    states.push(await vcs.gitState(repo));
    gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    states.push(await vcs.gitState(repo));

    const keys = states.map((s) => s?.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a worktree's state comes from its own HEAD and the refs of the main repo", async () => {
    const vcs = new Vcs();
    const repo = makeRepo({ "a.txt": "1" });
    const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-wt-")), "wt");
    gitIn(repo, "worktree", "add", "-q", "-b", "task", worktree);
    const before = await vcs.gitState(worktree);
    expect(before).not.toBeNull();

    commitFiles(worktree, { "b.txt": "1" }, "in the worktree");

    expect((await vcs.gitState(worktree))?.key).not.toBe(before?.key);
  });

  test("a directory without a readable git directory has no state", async () => {
    const vcs = new Vcs();
    const dir = mkdtempSync(join(tmpdir(), "trackwall-nogit-"));
    expect(await vcs.gitState(dir)).toBeNull();
    writeFileSync(join(dir, ".git"), "gitdir: ../nowhere\n");
    expect(await vcs.gitState(dir)).toBeNull();
  });
});

describe("the repo watch", () => {
  test("the first comparison hands over every repo, the most recently used first, and bumps the revision once", async () => {
    const { projects, watch, handed } = await setup();
    const old = makeRepo({ "a.txt": "1" }, "old", projects);
    makeRepo({ "a.txt": "1" }, "recent", projects);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(old, ".git", "logs", "HEAD"), past, past);

    await watch.check();

    expect(handed).toEqual([["recent", "old"]]);
    expect(watch.changes()).toEqual({ revision: 1 });
  });

  test("without a change nothing is handed over and the revision stays, a commit hands over only its repo", async () => {
    const { projects, watch, handed } = await setup();
    const shop = makeRepo({ "a.txt": "1" }, "shop", projects);
    makeRepo({ "a.txt": "1" }, "web", projects);
    await watch.check();
    gitIn(shop, "status");
    await watch.check();
    expect(watch.changes()).toEqual({ revision: 1 });

    commitFiles(shop, { "a.txt": "2" }, "second");
    await watch.check();

    expect(handed.slice(1)).toEqual([["shop"]]);
    expect(watch.changes()).toEqual({ revision: 2 });
  });

  test("a repo added to the folder is handed over, and a removed one bumps the revision without a handover", async () => {
    const { projects, watch, handed } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    await watch.check();

    const added = makeRepo({ "a.txt": "1" }, "added", projects);
    await watch.check();
    expect(handed.slice(1)).toEqual([["added"]]);

    rmSync(added, { recursive: true, force: true });
    await watch.check();
    expect(handed).toHaveLength(2);
    expect(watch.changes()).toEqual({ revision: 3 });
  });

  test("a directory that becomes a repo later (git clone from a terminal) is handed over when its .git appears", async () => {
    const { projects, watch, handed } = await setup();
    mkdirSync(join(projects, "cloning"));
    await watch.check();
    expect(handed).toEqual([]);

    gitIn(join(projects, "cloning"), "init", "-q", "-b", "main");
    await watch.check();

    expect(handed).toEqual([["cloning"]]);
  });

  test("a projects folder that cannot be read is logged once and leaves no repos to watch", async () => {
    const { projects, watch, handed, logs } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    await watch.check();
    rmSync(projects, { recursive: true, force: true });

    await watch.check();
    await watch.check();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("repo watch cannot read the repo list");
    expect(handed).toHaveLength(1);
    expect(watch.changes()).toEqual({ revision: 2 });
  });

  test("a comparison asked for during a running one is that same comparison", async () => {
    const { projects, watch } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    expect(watch.check()).toBe(watch.check());
    await watch.check();
  });
});

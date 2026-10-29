import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFolder } from "../src/infra/remove-folder.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import type { RepoEntry } from "../src/modules/workspace/projects-dir.ts";
import { RepoWatch } from "../src/modules/workspace/repo-watch.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** The repo watch on real git and a real projects folder; the test runs each comparison itself instead of a timer. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const vcs = new Vcs(systemTempFolder);
  const workspace = new Workspace({
    file: new WorkspaceFile(join(home, "workspace.yaml")),
    vcs,
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
    afterClone: async () => {},
  });
  await workspace.setProjectsDir(projects);
  const handed: string[][] = [];
  const watch = new RepoWatch({
    repos: workspace,
    vcs,
    onHeadMoved: (repos: RepoEntry[]) => handed.push(repos.map((r) => r.id)),
    log: () => {},
  });
  const revision = () => watch.state().revision;
  return { home, projects, watch, handed, revision };
}

describe("the repo watch", () => {
  test("the first comparison hands over every repo, the most recently used first, and is revision 0", async () => {
    const { projects, watch, handed, revision } = await setup();
    const old = makeRepo({ "a.txt": "1" }, "old", projects);
    makeRepo({ "a.txt": "1" }, "recent", projects);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(old, ".git", "logs", "HEAD"), past, past);

    await watch.check();

    expect(handed).toEqual([["recent", "old"]]);
    expect(revision()).toBe(0);
  });

  test("without a change nothing happens, and a commit bumps the revision and hands over only its repo", async () => {
    const { projects, watch, handed, revision } = await setup();
    const shop = makeRepo({ "a.txt": "1" }, "shop", projects);
    makeRepo({ "a.txt": "1" }, "web", projects);
    await watch.check();
    gitIn(shop, "status");
    await watch.check();
    expect(revision()).toBe(0);

    commitFiles(shop, { "a.txt": "2" }, "second");
    await watch.check();

    expect(handed.slice(1)).toEqual([["shop"]]);
    expect(revision()).toBe(1);
  });

  test("a new branch or a fetched ref bumps the revision without a card warm-up, because HEAD stayed", async () => {
    const { projects, watch, handed, revision } = await setup();
    const shop = makeRepo({ "a.txt": "1" }, "shop", projects);
    await watch.check();

    gitIn(shop, "update-ref", "refs/remotes/origin/main", "HEAD");
    await watch.check();

    expect(revision()).toBe(1);
    expect(handed).toHaveLength(1);
  });

  test("a repo added to the folder is handed over, and a removed one bumps the revision without a handover", async () => {
    const { projects, watch, handed, revision } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    await watch.check();

    const added = makeRepo({ "a.txt": "1" }, "added", projects);
    await watch.check();
    expect(handed.slice(1)).toEqual([["added"]]);

    await removeFolder(added);
    await watch.check();
    expect(handed).toHaveLength(2);
    expect(revision()).toBe(2);
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

  test("a workspace.yaml that cannot be read for a moment keeps the previous repos, so its repair is no change", async () => {
    const { home, projects, watch, handed, revision } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    await watch.check();
    const file = join(home, "workspace.yaml");

    writeFileSync(file, "projectsDir: [unclosed\n");
    await expect(watch.check()).rejects.toThrow();
    writeFileSync(file, `projectsDir: ${JSON.stringify(projects)}\n`);
    await watch.check();

    expect(handed).toHaveLength(1);
    expect(revision()).toBe(0);
  });

  test("a comparison asked for during a running one is that same comparison", async () => {
    const { projects, watch } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    expect(watch.check()).toBe(watch.check());
    await watch.check();
  });

  test("a directory without a git directory is not handed to the warm-up", async () => {
    const { projects, watch, handed } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    mkdirSync(join(projects, "broken"));
    writeFileSync(join(projects, "broken", ".git"), "gitdir: ../nowhere\n");

    await watch.check();

    expect(handed).toEqual([["shop"]]);
  });

  test("a projects folder that only becomes readable after the start is a change", async () => {
    const { home, projects, watch, handed, revision } = await setup();
    makeRepo({ "a.txt": "1" }, "shop", projects);
    const file = join(home, "workspace.yaml");
    writeFileSync(file, "projectsDir: [unclosed\n");
    await expect(watch.check()).rejects.toThrow();

    writeFileSync(file, `projectsDir: ${JSON.stringify(projects)}\n`);
    await watch.check();

    expect(handed).toEqual([["shop"]]);
    expect(revision()).toBe(1);
  });

  test("a repo whose files cannot be read for one comparison keeps its state, so it is no change", async () => {
    const entries: RepoEntry[] = [{ id: "shop", path: "/projects/shop" }];
    const reads: ({ head: string; refs: string; usedMs: number } | undefined)[] = [
      { head: "h1", refs: "r1", usedMs: 0 },
      undefined,
      { head: "h1", refs: "r1", usedMs: 0 },
    ];
    const handed: string[][] = [];
    const watch = new RepoWatch({
      repos: { repoEntries: async () => entries },
      vcs: { gitStates: async () => new Map([["/projects/shop", reads.shift()]]) },
      onHeadMoved: (repos) => handed.push(repos.map((r) => r.id)),
      log: () => {},
    });

    await watch.check();
    await watch.check();
    await watch.check();

    expect(handed).toEqual([["shop"]]);
    expect(watch.state().revision).toBe(0);
  });
});

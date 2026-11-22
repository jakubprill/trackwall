import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** Every test runs dozens of git processes, and on Windows in CI one takes up to 100 ms. */
const GIT_HEAVY_MS = 30_000;

/** A workspace on a projects folder with the clone `shop` of a "server" repo (a local repo as the remote). */
async function shopCloned() {
  const vcs = new Vcs(systemTempFolder, tmpdir());
  const workspace = new Workspace({
    inContainer: false,
    file: new WorkspaceFile(join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml")),
    vcs,
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
    afterClone: async () => {},
  });
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  await workspace.setProjectsDir(projects);
  const server = makeRepo({ "README.md": "# shop\n" }, "shop", mkdtempSync(join(tmpdir(), "trackwall-remotes-")));
  gitIn(projects, "clone", "-q", server, "shop");
  return { workspace, vcs, server, clone: join(projects, "shop"), projects };
}

const head = (dir: string, ref = "HEAD") => gitIn(dir, "rev-parse", ref).trim();

describe("where a new task starts, against the server (ADR-296)", () => {
  test(
    "a fresh clone's default branch lacks nothing of the remote one, and the repo has not fetched since the clone",
    async () => {
      const { workspace } = await shopCloned();

      expect(await workspace.newTaskBase("shop")).toEqual({
        branch: "main",
        remoteBranch: "origin/main",
        behind: 0,
        ahead: 0,
        fetchedAt: null,
      });
    },
    GIT_HEAVY_MS,
  );

  test(
    "a fetch with another branch checked out leaves main behind the server's commits, and Sync main moves it there, where the next task starts",
    async () => {
      const { workspace, vcs, server, clone } = await shopCloned();
      gitIn(clone, "checkout", "-q", "-b", "discounts");
      commitFiles(server, { "orders.txt": "1" }, "Add orders");
      commitFiles(server, { "orders.txt": "2" }, "Add order totals");
      // A fetch that moves no branch: an editor's own, or a task's refresh from its base branch.
      const before = Date.now();
      gitIn(clone, "fetch", "-q");

      const base = await workspace.newTaskBase("shop");
      expect(base).toMatchObject({ branch: "main", remoteBranch: "origin/main", behind: 2, ahead: 0 });
      // File times are as coarse as two seconds on some file systems.
      expect(Date.parse(base?.fetchedAt ?? "")).toBeGreaterThanOrEqual(before - 2000);
      expect((await vcs.defaultBase(clone)).commit).toBe(head(clone, "main"));

      expect(await workspace.syncRepo("shop")).toMatchObject({
        state: "updated",
        branch: "main",
        commits: 2,
        workingTree: { branch: "discounts" },
      });
      expect(await workspace.newTaskBase("shop")).toMatchObject({ behind: 0, ahead: 0 });
      expect(await vcs.defaultBase(clone)).toEqual({ branch: "main", commit: head(server) });
      expect(head(clone)).toBe(head(clone, "discounts"));
    },
    GIT_HEAVY_MS,
  );

  test(
    "a main with commits of its own and of the server's has diverged, and Sync main leaves it as it is",
    async () => {
      const { workspace, server, clone } = await shopCloned();
      commitFiles(clone, { "local.txt": "mine" }, "Try a local fix");
      commitFiles(server, { "orders.txt": "1" }, "Add orders");
      gitIn(clone, "fetch", "-q");
      const local = head(clone, "main");

      expect(await workspace.newTaskBase("shop")).toMatchObject({ behind: 1, ahead: 1 });
      expect(await workspace.syncRepo("shop")).toMatchObject({ state: "skipped", reason: "diverged" });
      expect(head(clone, "main")).toBe(local);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a repo without a remote has nothing to compare, and an unknown repo is not_found",
    async () => {
      const { workspace, projects } = await shopCloned();
      makeRepo({ "README.md": "# notes\n" }, "notes", projects);

      expect(await workspace.newTaskBase("notes")).toBeNull();
      await expect(workspace.newTaskBase("missing")).rejects.toMatchObject({ code: "not_found" });
    },
    GIT_HEAVY_MS,
  );
});

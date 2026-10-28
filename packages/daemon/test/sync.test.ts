import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncRun } from "@trackwall/protocol";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** A workspace with an empty projects folder and a directory for "remote" repos (a local repo as the remote). */
async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const remotes = mkdtempSync(join(tmpdir(), "trackwall-remotes-"));
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs: new Vcs(systemTempFolder),
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
  });
  await workspace.setProjectsDir(projects);
  return { workspace, projects, remotes };
}

/** A remote repo `name` with one commit and its clone in the projects folder. */
function cloned(projects: string, remotes: string, name: string): { upstream: string; clone: string } {
  const upstream = makeRepo({ "README.md": `# ${name}\n` }, name, remotes);
  gitIn(projects, "clone", "-q", upstream, name);
  return { upstream, clone: join(projects, name) };
}

/** Every test runs dozens of git processes, and on Windows in CI one takes up to 100 ms. */
const GIT_HEAVY_MS = 30_000;

const head = (dir: string, ref = "HEAD") => gitIn(dir, "rev-parse", ref).trim();

async function finished(workspace: Workspace): Promise<SyncRun> {
  for (let i = 0; i < 400; i++) {
    const run = workspace.syncRun();
    if (run?.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the sync did not finish within the test");
}

describe("sync of all repos", () => {
  test(
    "a checked-out, clean default branch moves to the remote one together with the files, and an up-to-date one stays; the result says what is in the working directory",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const api = cloned(projects, remotes, "api");
      const web = cloned(projects, remotes, "web");
      commitFiles(api.upstream, { "new.txt": "1" }, "first remote");
      commitFiles(api.upstream, { "second.txt": "2" }, "second remote");

      const started = await workspace.sync();
      expect(started.finishedAt).toBeNull();
      expect(started.repos.map((r) => r.repo)).toEqual(["api", "web"]);
      const run = await finished(workspace);

      expect(run.repos).toEqual([
        {
          repo: "api",
          path: api.clone,
          state: "updated",
          branch: "main",
          remoteBranch: "origin/main",
          commits: 2,
          workingTree: { branch: "main", changed: 0, untracked: 0 },
        },
        {
          repo: "web",
          path: web.clone,
          state: "up-to-date",
          branch: "main",
          remoteBranch: "origin/main",
          workingTree: { branch: "main", changed: 0, untracked: 0 },
        },
      ]);
      expect(head(api.clone)).toBe(head(api.upstream));
      expect(existsSync(join(api.clone, "second.txt"))).toBe(true);
    },
    GIT_HEAVY_MS,
  );

  test(
    "syncing one repo by identifier moves only that repo, and an unknown repo is not_found",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const api = cloned(projects, remotes, "api");
      const web = cloned(projects, remotes, "web");
      commitFiles(api.upstream, { "new.txt": "1" }, "remote in api");
      commitFiles(web.upstream, { "new.txt": "1" }, "remote in web");
      const webBefore = head(web.clone);

      expect(await workspace.syncRepo("api")).toMatchObject({ state: "updated", branch: "main", commits: 1 });

      expect(head(api.clone)).toBe(head(api.upstream));
      expect(head(web.clone)).toBe(webBefore);
      await expect(workspace.syncRepo("missing")).rejects.toMatchObject({ code: "not_found" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "a default branch that is not checked out moves without changing the checked-out branch and the working directory",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      gitIn(clone, "switch", "-q", "-c", "feature");
      writeFileSync(join(clone, "README.md"), "change in progress\n");
      commitFiles(upstream, { "new.txt": "1" }, "remote");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({
        state: "updated",
        branch: "main",
        commits: 1,
        workingTree: { branch: "feature", changed: 1, untracked: 0 },
      });
      expect(head(clone, "refs/heads/main")).toBe(head(upstream));
      expect(gitIn(clone, "branch", "--show-current").trim()).toBe("feature");
      expect(existsSync(join(clone, "new.txt"))).toBe(false);
    },
    GIT_HEAVY_MS,
  );

  test(
    "changes on the checked-out branch, a diverged and an unpushed branch stay untouched with a reason",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const dirty = cloned(projects, remotes, "dirty");
      const diverged = cloned(projects, remotes, "diverged");
      const ahead = cloned(projects, remotes, "unpushed");
      for (const r of [dirty, diverged]) commitFiles(r.upstream, { "new.txt": "1" }, "remote");
      writeFileSync(join(dirty.clone, "README.md"), "local change\n");
      for (const r of [diverged, ahead]) commitFiles(r.clone, { "local.txt": "1" }, "local");
      const before = [dirty, diverged, ahead].map((r) => head(r.clone));

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos.map((r) => (r.state === "skipped" ? r.reason : r.state))).toEqual(["dirty", "diverged", "ahead"]);
      expect(run.repos[0]).toMatchObject({
        message: "main is checked out and has uncommitted changes",
        workingTree: { branch: "main", changed: 1, untracked: 0 },
      });
      expect(run.repos[2]).toMatchObject({ message: "main has 1 unpushed commit" });
      expect([dirty, diverged, ahead].map((r) => head(r.clone))).toEqual(before);
    },
    GIT_HEAVY_MS,
  );

  test(
    "an untracked file does not block sync, but git does not overwrite it with the file from the remote",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      writeFileSync(join(clone, "note.txt"), "mine");
      commitFiles(upstream, { "other.txt": "1" }, "remote");
      let run = await workspace.sync().then(() => finished(workspace));
      expect(run.repos[0]).toMatchObject({ state: "updated", commits: 1 });

      commitFiles(upstream, { "note.txt": "remote" }, "remote with the same file");
      run = await workspace.sync().then(() => finished(workspace));
      expect(run.repos[0]).toMatchObject({ state: "failed" });
      expect(gitIn(clone, "status", "--porcelain")).toContain("note.txt");
    },
    GIT_HEAVY_MS,
  );

  test(
    "an up-to-date repo with changed and new files lists them separately, and sync leaves them alone",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { clone } = cloned(projects, remotes, "api");
      writeFileSync(join(clone, "README.md"), "local change\n");
      writeFileSync(join(clone, "note.txt"), "mine");
      writeFileSync(join(clone, "draft.txt"), "mine");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({
        state: "up-to-date",
        remoteBranch: "origin/main",
        workingTree: { branch: "main", changed: 1, untracked: 2 },
      });
      expect(gitIn(clone, "status", "--porcelain").split("\n").filter(Boolean)).toHaveLength(3);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a branch checked out in another worktree and a missing local default branch are skipped",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const other = cloned(projects, remotes, "worktree");
      gitIn(other.clone, "switch", "-q", "-c", "feature");
      gitIn(other.clone, "worktree", "add", "-q", join(remotes, "worktree-main"), "main");
      const missing = cloned(projects, remotes, "no-main");
      gitIn(missing.clone, "branch", "-q", "-m", "main", "other");
      for (const r of [other, missing]) commitFiles(r.upstream, { "new.txt": "1" }, "remote");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos.map((r) => [r.repo, r.state === "skipped" ? r.reason : r.state])).toEqual([
        ["no-main", "no-local-branch"],
        ["worktree", "checked-out-elsewhere"],
      ]);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a default branch during bisect stays untouched, although HEAD is detached",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      commitFiles(upstream, { "a.txt": "1" }, "second");
      commitFiles(upstream, { "b.txt": "2" }, "third");
      gitIn(clone, "pull", "-q", "--ff-only");
      commitFiles(upstream, { "new.txt": "1" }, "remote");
      // Bisect detaches HEAD, but the branch it started from returns after `bisect reset`, so git treats it as checked out.
      gitIn(clone, "bisect", "start", "main", "main~2");
      const before = head(clone, "refs/heads/main");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ state: "failed" });
      expect(head(clone, "refs/heads/main")).toBe(before);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a repo and its worktree in the projects folder sync one after another, without a ref lock error",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      gitIn(clone, "worktree", "add", "-q", "-b", "feature", join(projects, "api-feature"));
      commitFiles(upstream, { "new.txt": "1" }, "remote");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos.map((r) => r.repo)).toEqual(["api", "api-feature"]);
      expect(run.repos.filter((r) => r.state === "failed")).toEqual([]);
      expect(head(clone)).toBe(head(upstream));
    },
    GIT_HEAVY_MS,
  );

  test(
    "after the repo host changes the default branch and the old one is deleted, the daemon asks the server for the new one",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      gitIn(upstream, "branch", "-q", "-m", "main", "trunk");
      gitIn(clone, "config", "fetch.prune", "true");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ state: "skipped", reason: "no-local-branch", message: expect.stringContaining("trunk") });
      expect(gitIn(clone, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe("refs/remotes/origin/trunk");
    },
    GIT_HEAVY_MS,
  );

  test(
    "a remote without any branch has no default branch",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const empty = makeRepo({}, "empty", remotes);
      gitIn(projects, "clone", "-q", empty, "empty");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ state: "skipped", reason: "no-default-branch" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "a repo without origin is skipped, and the daemon works out the default branch of a remote without HEAD itself",
    async () => {
      const { workspace, projects, remotes } = await setup();
      makeRepo({ a: "1" }, "local", projects);
      const upstream = makeRepo({ a: "1" }, "remote", remotes);
      const added = makeRepo({}, "added", projects);
      gitIn(added, "remote", "add", "origin", upstream);

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos.map((r) => [r.repo, r.state === "skipped" ? r.reason : r.state])).toEqual([
        ["added", "no-local-branch"],
        ["local", "no-remote"],
      ]);
      expect(gitIn(added, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe("refs/remotes/origin/main");
    },
    GIT_HEAVY_MS,
  );

  test(
    "a failed fetch of one repo is its result and does not stop the others",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const gone = cloned(projects, remotes, "a-gone");
      const ok = cloned(projects, remotes, "b-working");
      rmSync(gone.upstream, { recursive: true, force: true });
      commitFiles(ok.upstream, { "new.txt": "1" }, "remote");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ repo: "a-gone", state: "failed", message: expect.stringContaining("a-gone") });
      expect(run.repos[1]).toMatchObject({ repo: "b-working", state: "updated" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "a second request meanwhile returns the running sync, and without a projects folder there is nothing to sync",
    async () => {
      const { workspace, projects, remotes } = await setup();
      expect(workspace.syncRun()).toBeNull();
      cloned(projects, remotes, "api");

      const [first, second] = await Promise.all([workspace.sync(), workspace.sync()]);
      expect(second.startedAt).toBe(first.startedAt);
      await finished(workspace);

      const empty = new Workspace({
        file: new WorkspaceFile(join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml")),
        vcs: new Vcs(systemTempFolder),
        hosting: fakeHosting().hosting,
        openEditor: () => {},
        openFolder: () => {},
      });
      await expect(empty.sync()).rejects.toMatchObject({ code: "bad_request" });
      expect(empty.syncRun()).toBeNull();
    },
    GIT_HEAVY_MS,
  );

  test(
    "the repo list gives the origin address as an identifier next to the directory name",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { clone } = cloned(projects, remotes, "api");
      makeRepo({ a: "1" }, "no-remote-repo", projects);
      gitIn(clone, "remote", "set-url", "origin", "git@gitlab.example.com:shop/Orders-API.git");

      const { repos } = await workspace.list();

      expect(repos.map((r) => [r.id, r.remote])).toEqual([
        ["api", "gitlab.example.com/shop/Orders-API"],
        ["no-remote-repo", null],
      ]);
    },
    GIT_HEAVY_MS,
  );
});

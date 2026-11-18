import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { BackupManifest } from "../src/modules/work-backup/manifest.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// The work backup (ADR-274) through the real facade, real git and the system's `tar`: work that lives only in the
// container's volume goes into one file, and from that file alone, with a fresh clone of the remote, every commit,
// stash and uncommitted change comes back, while the repo the backup read stays exactly as it was.

/** A facade on a fresh state folder and projects folder, in a container or not (ADR-162). */
async function facadeWith(inContainer: boolean) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-backup-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-backup-projects-"));
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
  await facade.workspace.setProjectsDir(projects);
  return { facade, projects };
}

/** A repo in `projects` with `main` pushed to a bare remote outside the projects folder, which it tracks. */
function pushedRepo(projects: string, name: string): { dir: string; remote: string } {
  const dir = makeRepo({ "README.md": "# repo\n", ".gitignore": ".env\n" }, name, projects);
  const remote = join(mkdtempSync(join(tmpdir(), "trackwall-backup-remote-")), `${name}.git`);
  gitIn(dir, "init", "-q", "--bare", remote);
  gitIn(dir, "remote", "add", "origin", remote);
  gitIn(dir, "push", "-q", "-u", "origin", "main");
  return { dir, remote };
}

/** The backup file as the download hands it out, unpacked by the system's `tar` into a new folder. */
async function downloadedAndUnpacked(facade: Awaited<ReturnType<typeof facadeWith>>["facade"]): Promise<{ dir: string; name: string }> {
  const file = await facade.workBackup.download();
  const bytes = await file.handle.readFile();
  await file.handle.close();
  const dir = mkdtempSync(join(tmpdir(), "trackwall-backup-unpacked-"));
  writeFileSync(join(dir, "backup.tar.gz"), bytes);
  execFileSync("tar", ["xzf", "backup.tar.gz"], { cwd: dir });
  return { dir, name: file.name };
}

describe("the work backup of a container (ADR-274)", () => {
  test(
    "commits on no remote, a stash and a task worktree's uncommitted files come back from the file alone; ignored files stay out",
    async () => {
      const { facade, projects } = await facadeWith(true);
      const { dir: api, remote } = pushedRepo(projects, "api");
      commitFiles(api, { "a.txt": "ahead\n" }, "ahead of origin");
      gitIn(api, "switch", "-q", "-c", "feature");
      commitFiles(api, { "b.txt": "feature\n" }, "only on feature");
      gitIn(api, "switch", "-q", "main");
      writeFileSync(join(api, "README.md"), "# stashed\n");
      gitIn(api, "stash", "push", "-q", "-m", "half a README");
      const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-backup-worktrees-")), "task");
      gitIn(api, "worktree", "add", "-q", "-b", "task-1", worktree, "origin/main");
      writeFileSync(join(worktree, "new.txt"), "draft\n");
      writeFileSync(join(worktree, "README.md"), "# changed\n");
      writeFileSync(join(worktree, ".env"), "TOKEN=secret\n");
      gitIn(worktree, "add", "README.md");
      gitIn(api, "remote", "add", "upstream", "https://oauth2:glpat-secret@gitlab.example.com/group/api.git");
      const before = {
        refs: gitIn(api, "for-each-ref"),
        status: gitIn(worktree, "status", "--porcelain"),
        staged: gitIn(worktree, "diff", "--cached", "--name-only"),
      };
      mkdirSync(join(projects, ".trackwall", "board"), { recursive: true });
      writeFileSync(join(projects, ".trackwall", "board", "launch.md"), "# Launch\n");

      const info = await facade.workBackup.create();

      expect(info).toMatchObject({ repos: 1, branches: 2, stashes: 1, changedWorktrees: 1, skipped: [] });
      expect(info.stateFiles).toBeGreaterThanOrEqual(2);
      // The repo the backup read is as it was: no ref of the backup's, the task's staged file still staged.
      expect({
        refs: gitIn(api, "for-each-ref"),
        status: gitIn(worktree, "status", "--porcelain"),
        staged: gitIn(worktree, "diff", "--cached", "--name-only"),
      }).toEqual(before);

      const unpacked = await downloadedAndUnpacked(facade);
      expect(unpacked.name).toBe(info.fileName);
      const manifest = BackupManifest.parse(JSON.parse(readFileSync(join(unpacked.dir, "manifest.json"), "utf8")));
      const [backedUp] = manifest.repos;
      if (!backedUp) throw new Error("the manifest lists no repo");
      // A remote on a repo host, without the token its address carried; a folder on this computer is no place to clone from.
      expect(backedUp.remotes).toEqual([{ name: "upstream", url: "https://gitlab.example.com/group/api.git" }]);
      expect(manifest.state.map((s) => s.path)).toContain(".trackwall/board/launch.md");

      // The volume is gone: a fresh clone of the remote and the bundle are all there is.
      const restored = join(mkdtempSync(join(tmpdir(), "trackwall-backup-restored-")), "api");
      gitIn(tmpdir(), "clone", "-q", "-b", "main", remote, restored);
      gitIn(restored, "fetch", "-q", join(unpacked.dir, backedUp.entry), "refs/*:refs/restored/*");
      expect(gitIn(restored, "log", "--format=%s", "refs/restored/heads/main", "-1")).toBe("ahead of origin\n");
      expect(gitIn(restored, "log", "--format=%s", "refs/restored/heads/feature", "-1")).toBe("only on feature\n");
      const stash = backedUp.stashes[0];
      expect(stash?.message).toBe("On main: half a README");
      expect(gitIn(restored, "show", `${stash?.ref.replace("refs/", "refs/restored/")}:README.md`)).toBe("# stashed\n");
      const changes = backedUp.worktrees.find((w) => w.changes !== null)?.changes;
      if (!changes) throw new Error("no worktree's changes in the manifest");
      const changesRef = changes.replace("refs/", "refs/restored/");
      expect(gitIn(restored, "show", `${changesRef}:new.txt`)).toBe("draft\n");
      expect(gitIn(restored, "show", `${changesRef}:README.md`)).toBe("# changed\n");
      expect(gitIn(restored, "ls-tree", "--name-only", changesRef)).not.toContain(".env");
      expect(readFileSync(join(unpacked.dir, manifest.state.find((s) => s.path.endsWith("launch.md"))?.entry ?? ""), "utf8")).toBe(
        "# Launch\n",
      );
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a repo whose work is all pushed is not in the backup",
    async () => {
      const { facade, projects } = await facadeWith(true);
      pushedRepo(projects, "clean");
      const { dir } = pushedRepo(projects, "api");
      commitFiles(dir, { "a.txt": "1\n" }, "ahead");

      const info = await facade.workBackup.create();
      const unpacked = await downloadedAndUnpacked(facade);

      expect(info.repos).toBe(1);
      const manifest = BackupManifest.parse(JSON.parse(readFileSync(join(unpacked.dir, "manifest.json"), "utf8")));
      expect(manifest.repos.map((r) => r.repo)).toEqual(["api"]);
      expect((await facade.workBackup.state()).last).toEqual(info);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("outside a container there is no backup to make, and before the first one nothing to download", async () => {
    const { facade } = await facadeWith(false);

    expect(await facade.workBackup.state()).toEqual({ inContainer: false, last: null, running: false });
    await expect(facade.workBackup.create()).rejects.toThrow(/only where Trackwall runs in a container/);
    await expect(facade.workBackup.download()).rejects.toThrow(/no work backup yet/);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { useGitProgram } from "../src/modules/vcs/git-program.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

/** The "Git program" setting (ADR-112): a git chosen by its full path runs the daemon's local git calls. */

/** The full path of the git on `PATH`, the one a user would type into the setting. */
function gitOnPath(): string {
  const name = process.platform === "win32" ? "git.exe" : "git";
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  const found = dirs.map((dir) => join(dir, name)).find((path) => existsSync(path));
  if (!found) throw new Error("no git on PATH");
  return found;
}

async function workspaceWithRepo() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const vcs = new Vcs(systemTempFolder);
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs,
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
  });
  await workspace.setProjectsDir(projects);
  makeRepo({ "README.md": "# orders" }, "orders", projects);
  return { workspace, vcs, file };
}

describe("the Git program setting", () => {
  // The setting lives in `vcs` for the whole process; a test must not leave it to the next one.
  afterEach(() => useGitProgram(null));

  test(
    "a git chosen by its full path is saved in workspace.yaml, runs the repo list at once, and Use default goes back to PATH",
    async () => {
      const { workspace, vcs, file } = await workspaceWithRepo();
      const git = gitOnPath();

      const settings = await workspace.setGitProgram(git);

      expect(settings.gitProgram).toBe(git);
      expect(readFileSync(file, "utf8")).toContain("gitProgram:");
      expect((await vcs.version(15_000)).chosen).toBe(git);
      const [orders] = (await workspace.list()).repos;
      expect(orders?.status.kind).toBe("ok");

      expect((await workspace.setGitProgram(null)).gitProgram).toBeNull();
      expect(readFileSync(file, "utf8")).not.toContain("gitProgram:");
      expect((await vcs.version(15_000)).chosen).toBeNull();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a program that does not answer like git is refused, and nothing is saved",
    async () => {
      const { workspace, file } = await workspaceWithRepo();

      // Node or Bun prints its own version, not `git version …`.
      await expect(workspace.setGitProgram(process.execPath)).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("cannot be used as the git program"),
      });
      expect(readFileSync(file, "utf8")).not.toContain("gitProgram:");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("a program named without its full path is refused", async () => {
    const { workspace } = await workspaceWithRepo();

    await expect(workspace.setGitProgram("git")).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("must be a full path"),
    });
  });

  test(
    "a chosen git that does not answer leaves the daemon on git from PATH, the repo list keeps working and the doctor's source says so",
    async () => {
      const { workspace, vcs, file } = await workspaceWithRepo();
      const missing = join(tmpdir(), "trackwall-no-such-git", process.platform === "win32" ? "git.exe" : "git");
      new WorkspaceFile(file).setGitProgram(missing);

      workspace.useGitProgramFromFile();

      expect(await vcs.version(15_000)).toMatchObject({ source: "fallback", chosen: missing, program: "git" });
      const [orders] = (await workspace.list()).repos;
      expect(orders?.status.kind).toBe("ok");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a git typed into workspace.yaml by hand runs once Settings reads it",
    async () => {
      const { workspace, vcs, file } = await workspaceWithRepo();
      const git = gitOnPath();
      new WorkspaceFile(file).setGitProgram(git);

      expect(workspace.settings().gitProgram).toBe(git);

      expect((await vcs.version(15_000)).source).toBe("chosen");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a git saved in workspace.yaml is used from the daemon's start",
    async () => {
      const { workspace, vcs, file } = await workspaceWithRepo();
      const git = gitOnPath();
      new WorkspaceFile(file).setGitProgram(git);

      workspace.useGitProgramFromFile();

      expect((await vcs.version(15_000)).chosen).toBe(git);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

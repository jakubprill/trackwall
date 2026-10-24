import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

function newWorkspace() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  return new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), hosting: fakeHosting().hosting, openEditor: () => {} });
}

/** A folder with a `.git` directory: enough for the repo list rule (ADR-18), without running git. */
function fakeRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("dropped folder", () => {
  test("a repo from the projects folder is the listed repo, also with a trailing separator", async () => {
    const workspace = newWorkspace();
    const projects = tempDir("trackwall-projects-");
    const shop = makeRepo({ "a.txt": "1" }, "Shop", projects);
    await workspace.setProjectsDir(projects);

    expect(await workspace.droppedFolder(shop)).toEqual({ kind: "listed-repo", repo: "shop" });
    expect(await workspace.droppedFolder(`${shop}${sep}`)).toEqual({ kind: "listed-repo", repo: "shop" });
  });

  test("a git repo outside the projects folder names its parent folder and the repos in it", async () => {
    const workspace = newWorkspace();
    await workspace.setProjectsDir(tempDir("trackwall-projects-"));
    const elsewhere = tempDir("trackwall-elsewhere-");
    const api = fakeRepo(elsewhere, "api");
    fakeRepo(elsewhere, "web");
    mkdirSync(join(elsewhere, "notes"));

    expect(await workspace.droppedFolder(api)).toEqual({ kind: "repo-elsewhere", path: api, parent: elsewhere, parentRepos: 2 });
  });

  test("a folder with repos directly inside it counts them and says whether it already is the projects folder", async () => {
    const workspace = newWorkspace();
    const projects = tempDir("trackwall-projects-");
    fakeRepo(projects, "api");
    await workspace.setProjectsDir(projects);
    const other = tempDir("trackwall-other-");
    fakeRepo(other, "a");
    fakeRepo(other, "b");

    expect(await workspace.droppedFolder(other)).toEqual({ kind: "folder-with-repos", path: other, repos: 2, current: false });
    expect(await workspace.droppedFolder(projects)).toEqual({ kind: "folder-with-repos", path: projects, repos: 1, current: true });
  });

  test("a folder whose repos are deeper than one level has no repos, and a file is a file", async () => {
    const workspace = newWorkspace();
    const folder = tempDir("trackwall-deep-");
    fakeRepo(join(folder, "group"), "api");
    const file = join(folder, "notes.txt");
    writeFileSync(file, "x");

    expect(await workspace.droppedFolder(folder)).toEqual({ kind: "no-repos", path: folder });
    expect(await workspace.droppedFolder(file)).toEqual({ kind: "file", path: file });
  });

  test("a missing or relative path is bad_request", async () => {
    const workspace = newWorkspace();

    await expect(workspace.droppedFolder(join(tmpdir(), "trackwall-no-such-folder"))).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("does not exist"),
    });
    await expect(workspace.droppedFolder("projects")).rejects.toMatchObject({ code: "bad_request" });
  });

  test("without a projects folder, or with one that is gone, a dropped folder is still described", async () => {
    const workspace = newWorkspace();
    const other = tempDir("trackwall-other-");
    fakeRepo(other, "a");
    expect(await workspace.droppedFolder(other)).toMatchObject({ kind: "folder-with-repos", current: false });

    const projects = tempDir("trackwall-projects-");
    await workspace.setProjectsDir(projects);
    rmSync(projects, { recursive: true });
    expect(await workspace.droppedFolder(other)).toMatchObject({ kind: "folder-with-repos", current: false });
  });
});

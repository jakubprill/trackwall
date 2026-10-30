import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloneJob } from "@trackwall/protocol";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { finishedClone } from "./support/clone-jobs.ts";
import { type FakeHostingConfig, fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com" } as const;

const project = (path: string) => ({
  path_with_namespace: path,
  description: null,
  web_url: `https://gitlab.example.com/${path}`,
  last_activity_at: null,
});

/** A workspace with a projects folder, a GitLab repo host in the settings and a fake glab. */
async function workspaceWithGitLab(config: FakeHostingConfig = {}, afterClone = async (_dir: string) => {}) {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs: new Vcs(systemTempFolder),
    hosting: fakeHosting(config).hosting,
    openEditor: () => {},
    openFolder: () => {},
    afterClone,
  });
  await workspace.setProjectsDir(projects);
  workspace.setRepoHosts([GITLAB]);
  return { workspace, projects, file };
}

function finished(workspace: Workspace, fullName: string): Promise<CloneJob | undefined> {
  return finishedClone(() => workspace.cloneJobs(), fullName);
}

describe("cloning from a repo host into the projects folder", () => {
  test("the repo host list says which repos are already in the folder, regardless of case", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ repos: [project("shop/Orders-BFF"), project("shop/web")] });
    mkdirSync(join(projects, "orders-bff"));

    const list = await workspace.remoteRepos("");

    expect(list.projectsDir).toBe(projects);
    expect(list.hosts).toEqual([
      {
        host: GITLAB,
        listing: {
          kind: "ok",
          truncated: false,
          repos: [
            expect.objectContaining({ fullName: "shop/Orders-BFF", dir: "Orders-BFF", inProjectsDir: true }),
            expect.objectContaining({ fullName: "shop/web", dir: "web", inProjectsDir: false }),
          ],
        },
      },
    ]);
  });

  test("a repo host that does not answer is unavailable with a message, and the others work", async () => {
    const { workspace } = await workspaceWithGitLab({
      repos: [project("shop/api")],
      apiErrors: { "gitlab.example.com": "glab: you are not signed in" },
    });
    workspace.setRepoHosts([GITLAB, { kind: "gitlab", host: "second.example.com" }]);

    const { hosts } = await workspace.remoteRepos("");

    expect(hosts.map((h) => [h.host.host, h.listing.kind])).toEqual([
      ["gitlab.example.com", "unavailable"],
      ["second.example.com", "ok"],
    ]);
    expect(hosts[0]?.listing).toEqual({ kind: "unavailable", message: "glab: you are not signed in" });
  });

  test("a clone runs in the background, and after it the repo is on the folder list", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ cloneDelayMs: 200 });

    const started = await workspace.clone(GITLAB, "shop/orders/orders-bff");
    expect(started).toEqual({
      host: GITLAB,
      fullName: "shop/orders/orders-bff",
      path: join(projects, "orders-bff"),
      state: "running",
    });
    // A second click meanwhile does not start a second clone.
    expect(await workspace.clone(GITLAB, "shop/orders/orders-bff")).toEqual(started);

    expect(await finished(workspace, "shop/orders/orders-bff")).toMatchObject({ state: "done" });
    expect((await workspace.list("fresh")).repos.map((r) => r.id)).toEqual(["orders-bff"]);
    await expect(workspace.clone(GITLAB, "shop/orders/orders-bff")).rejects.toMatchObject({
      code: "bad_request",
      message: "the projects folder already has orders-bff",
    });
  });

  test("after the clone the folder goes to afterClone, and the clone is done only once it has finished", async () => {
    const seen: { dir: string; state: string | undefined; files: string[] }[] = [];
    const { workspace, projects } = await workspaceWithGitLab({}, async (dir) => {
      seen.push({ dir, state: workspace.cloneJobs()[0]?.state, files: readdirSync(dir) });
    });

    await workspace.clone(GITLAB, "shop/orders/orders-bff");

    expect(await finished(workspace, "shop/orders/orders-bff")).toMatchObject({ state: "done" });
    expect(seen).toEqual([{ dir: join(projects, "orders-bff"), state: "running", files: [".git"] }]);
  });

  test("a failed clone stays on the clone list with the glab message", async () => {
    const { workspace } = await workspaceWithGitLab({ cloneErrors: { "shop/api": "fatal: repository not found" } });

    await workspace.clone(GITLAB, "shop/api");

    expect(await finished(workspace, "shop/api")).toMatchObject({ state: "failed", message: "fatal: repository not found" });
  });

  test("a second repo with the same directory name waits until the first one finishes", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ cloneDelayMs: 200 });
    await workspace.clone(GITLAB, "shop/api");

    await expect(workspace.clone(GITLAB, "warehouse/API")).rejects.toMatchObject({
      code: "bad_request",
      message: `shop/api is already being cloned into ${join(projects, "API")}`,
    });
    await finished(workspace, "shop/api");
  });

  test("a repo being cloned is not removed from the projects folder (ADR-83)", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ cloneDelayMs: 300 });
    await workspace.clone(GITLAB, "shop/api");
    // git makes the folder and its `.git` first, so the repo is listed while the clone still runs.
    const path = join(projects, "api");
    mkdirSync(join(path, ".git"), { recursive: true });

    await expect(workspace.removeRepo("api", path, () => {})).rejects.toThrow("api is still being cloned; wait for the clone to end");
    expect(readdirSync(projects)).toContain("api");
    await finished(workspace, "shop/api");
  });

  test("a running clone into the old projects folder does not block a clone with the same name into the new one", async () => {
    const { workspace } = await workspaceWithGitLab({ cloneDelayMs: 200 });
    await workspace.clone(GITLAB, "shop/api");
    const newDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    await workspace.setProjectsDir(newDir);

    expect(await workspace.clone(GITLAB, "warehouse/api")).toMatchObject({ path: join(newDir, "api"), state: "running" });
    expect(workspace.cloneJobs().map((j) => j.fullName)).toEqual(["warehouse/api"]);
    await finished(workspace, "warehouse/api");
  });

  test("the same repo can be cloned again into a new projects folder", async () => {
    const { workspace } = await workspaceWithGitLab();
    await workspace.clone(GITLAB, "shop/api");
    await finished(workspace, "shop/api");
    const newDir = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    await workspace.setProjectsDir(newDir);

    expect(workspace.cloneJobs()).toEqual([]);
    expect(await workspace.clone(GITLAB, "shop/api")).toMatchObject({ path: join(newDir, "api"), state: "running" });
    expect(await finished(workspace, "shop/api")).toMatchObject({ path: join(newDir, "api"), state: "done" });
  });

  test("a clone from a repo host outside the settings or without a projects folder is rejected", async () => {
    const { workspace } = await workspaceWithGitLab();
    await expect(workspace.clone({ kind: "gitlab", host: "other.example.com" }, "shop/api")).rejects.toMatchObject({ code: "bad_request" });

    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const bare = new Workspace({
      file: new WorkspaceFile(file),
      vcs: new Vcs(systemTempFolder),
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
      afterClone: async () => {},
    });
    bare.setRepoHosts([GITLAB]);
    await expect(bare.clone(GITLAB, "shop/api")).rejects.toMatchObject({
      code: "bad_request",
      message: "set the projects folder first",
    });
  });

  test("repo hosts are saved in workspace.yaml as the repoHosts list", async () => {
    const { workspace, file } = await workspaceWithGitLab();

    expect(workspace.repoHosts()).toEqual([GITLAB]);
    expect(readFileSync(file, "utf8")).toContain("repoHosts:\n  - kind: gitlab\n    host: gitlab.example.com\n");
  });
});

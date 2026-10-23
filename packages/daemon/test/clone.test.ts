import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloneJob } from "@trackwall/protocol";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { type FakeHostingConfig, fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com" } as const;

const project = (path: string) => ({
  path_with_namespace: path,
  description: null,
  web_url: `https://gitlab.example.com/${path}`,
  last_activity_at: null,
});

/** Workspace z folderem z projektami, hostingiem GitLab w ustawieniach i atrapą glab. */
async function workspaceWithGitLab(config: FakeHostingConfig = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs: new Vcs(),
    hosting: fakeHosting(config).hosting,
    openUrl: () => {},
  });
  await workspace.setProjectsDir(projects);
  workspace.setRepoHosts([GITLAB]);
  return { workspace, projects, file };
}

async function finished(workspace: Workspace, fullName: string): Promise<CloneJob | undefined> {
  for (let i = 0; i < 200; i++) {
    const job = workspace.cloneJobs().find((j) => j.fullName === fullName);
    if (job?.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`klon ${fullName} nie skończył się w czasie testu`);
}

describe("klonowanie z hostingu do folderu z projektami", () => {
  test("lista z hostingu mówi, które repo już są w folderze, bez względu na wielkość liter", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ repos: [project("sklep/Orders-BFF"), project("sklep/web")] });
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
            expect.objectContaining({ fullName: "sklep/Orders-BFF", dir: "Orders-BFF", inProjectsDir: true }),
            expect.objectContaining({ fullName: "sklep/web", dir: "web", inProjectsDir: false }),
          ],
        },
      },
    ]);
  });

  test("hosting, który nie odpowiada, jest niedostępny z komunikatem, a pozostałe działają", async () => {
    const { workspace } = await workspaceWithGitLab({
      repos: [project("sklep/api")],
      apiErrors: { "gitlab.example.com": "glab: nie jesteś zalogowany" },
    });
    workspace.setRepoHosts([GITLAB, { kind: "gitlab", host: "drugi.example.com" }]);

    const { hosts } = await workspace.remoteRepos("");

    expect(hosts.map((h) => [h.host.host, h.listing.kind])).toEqual([
      ["gitlab.example.com", "unavailable"],
      ["drugi.example.com", "ok"],
    ]);
    expect(hosts[0]?.listing).toEqual({ kind: "unavailable", message: "glab: nie jesteś zalogowany" });
  });

  test("klon trwa w tle, a po nim repo jest na liście z folderu", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ cloneDelayMs: 200 });

    const started = await workspace.clone(GITLAB, "sklep/zamowienia/orders-bff");
    expect(started).toEqual({
      host: GITLAB,
      fullName: "sklep/zamowienia/orders-bff",
      path: join(projects, "orders-bff"),
      state: "running",
    });
    // Drugie kliknięcie w trakcie nie zaczyna drugiego klonu.
    expect(await workspace.clone(GITLAB, "sklep/zamowienia/orders-bff")).toEqual(started);

    expect(await finished(workspace, "sklep/zamowienia/orders-bff")).toMatchObject({ state: "done" });
    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["orders-bff"]);
    await expect(workspace.clone(GITLAB, "sklep/zamowienia/orders-bff")).rejects.toMatchObject({
      code: "bad_request",
      message: "w folderze z projektami jest już orders-bff",
    });
  });

  test("nieudany klon zostaje na liście klonowań z komunikatem glab", async () => {
    const { workspace } = await workspaceWithGitLab({ cloneErrors: { "sklep/api": "fatal: repository not found" } });

    await workspace.clone(GITLAB, "sklep/api");

    expect(await finished(workspace, "sklep/api")).toMatchObject({ state: "failed", message: "fatal: repository not found" });
  });

  test("drugie repo o tej samej nazwie katalogu czeka, aż skończy się pierwsze", async () => {
    const { workspace, projects } = await workspaceWithGitLab({ cloneDelayMs: 200 });
    await workspace.clone(GITLAB, "sklep/api");

    await expect(workspace.clone(GITLAB, "magazyn/API")).rejects.toMatchObject({
      code: "bad_request",
      message: `do ${join(projects, "API")} trwa już klonowanie sklep/api`,
    });
    await finished(workspace, "sklep/api");
  });

  test("klon z hostingu spoza ustawień albo bez folderu z projektami jest odrzucany", async () => {
    const { workspace } = await workspaceWithGitLab();
    await expect(workspace.clone({ kind: "gitlab", host: "inny.example.com" }, "sklep/api")).rejects.toMatchObject({ code: "bad_request" });

    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const bare = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), hosting: fakeHosting().hosting, openUrl: () => {} });
    bare.setRepoHosts([GITLAB]);
    await expect(bare.clone(GITLAB, "sklep/api")).rejects.toMatchObject({
      code: "bad_request",
      message: "najpierw ustaw folder z projektami",
    });
  });

  test("hostingi zapisują się w workspace.yaml jako lista repoHosts", async () => {
    const { workspace, file } = await workspaceWithGitLab();

    expect(workspace.settings().repoHosts).toEqual([GITLAB]);
    expect(readFileSync(file, "utf8")).toContain("repoHosts:\n  - kind: gitlab\n    host: gitlab.example.com\n");
  });
});

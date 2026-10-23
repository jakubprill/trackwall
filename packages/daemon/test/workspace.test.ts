import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { vscodeUrl } from "../src/modules/workspace/editor-url.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { makeRepo } from "./support/git-repo.ts";

/** Workspace z pustym folderem z projektami; realpath, bo tmpdir na macOS to dowiązanie do /private, a na Windowsie bywa krótką nazwą 8.3. */
function newWorkspace() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = realpathSync.native(mkdtempSync(join(tmpdir(), "trackwall-projekty-")));
  const opened: string[] = [];
  const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), openUrl: (url) => opened.push(url) });
  workspace.setProjectsDir(projects);
  return { workspace, file, projects, opened };
}

describe("workspace", () => {
  test("lista to repo gita z folderu z projektami, posortowane, bez zwykłych katalogów, plików i ukrytych katalogów", async () => {
    const { workspace, projects } = newWorkspace();
    makeRepo({ a: "1" }, "web", projects);
    makeRepo({ a: "1" }, "Orders BFF", projects);
    makeRepo({ a: "1" }, ".ukryte", projects);
    mkdirSync(join(projects, "notatki"));
    writeFileSync(join(projects, "plik.txt"), "x");

    const { projectsDir, repos } = await workspace.list();

    expect(projectsDir).toBe(projects);
    expect(repos.map((r) => [r.id, r.path, r.status.kind])).toEqual([
      ["orders-bff", join(projects, "Orders BFF"), "ok"],
      ["web", join(projects, "web"), "ok"],
    ]);
  });

  test("repo sklonowane albo usunięte poza Trackwallem pojawia się i znika przy następnym zapytaniu", async () => {
    const { workspace, projects } = newWorkspace();
    expect((await workspace.list()).repos).toEqual([]);

    const dir = makeRepo({ a: "1" }, "api", projects);
    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["api"]);

    rmSync(dir, { recursive: true, force: true });
    expect((await workspace.list()).repos).toEqual([]);
    await expect(workspace.overview("api")).rejects.toMatchObject({ code: "not_found" });
  });

  test("katalogi, których nazwy dają ten sam identyfikator, dostają przyrostki w stałej kolejności", async () => {
    const { workspace, projects } = newWorkspace();
    makeRepo({}, "Zażółć", projects);
    makeRepo({}, "zazolc", projects);

    expect((await workspace.list()).repos.map((r) => [r.id, r.path])).toEqual([
      ["zazolc", join(projects, "zazolc")],
      ["zazolc-2", join(projects, "Zażółć")],
    ]);
  });

  test("bez ustawionego folderu lista jest pusta, a repo nie da się otworzyć", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), openUrl: () => {} });

    expect(await workspace.list()).toEqual({ projectsDir: null, repos: [] });
    expect(workspace.settings()).toEqual({ projectsDir: null, configFile: file });
    await expect(workspace.overview("api")).rejects.toMatchObject({ code: "not_found" });
  });

  test("ustawienie folderu zapisuje pełną ścieżkę w workspace.yaml", () => {
    const { workspace, file, projects } = newWorkspace();
    expect(workspace.settings()).toEqual({ projectsDir: projects, configFile: file });
    expect(readFileSync(file, "utf8")).toContain(`projectsDir: ${projects}`);
  });

  test("ścieżka względna, nieistniejąca albo do pliku jest odrzucana jako bad_request i niczego nie zapisuje", () => {
    const { workspace, projects } = newWorkspace();
    writeFileSync(join(projects, "plik.txt"), "x");

    expect(() => workspace.setProjectsDir("wzgledna/sciezka")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => workspace.setProjectsDir(join(projects, "nie-ma"))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => workspace.setProjectsDir(join(projects, "plik.txt"))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(workspace.settings().projectsDir).toBe(projects);
  });

  test("folder, który zniknął po ustawieniu, to projects_dir_unavailable z jego ścieżką", async () => {
    const { workspace, projects } = newWorkspace();
    rmSync(projects, { recursive: true, force: true });

    await expect(workspace.list()).rejects.toMatchObject({ code: "projects_dir_unavailable", message: expect.stringContaining(projects) });
  });

  test("repo, którego git nie czyta, zostaje na liście jako niedostępne", async () => {
    const { workspace, projects } = newWorkspace();
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });

    const [repo] = (await workspace.list()).repos;
    expect(repo).toMatchObject({ id: "zepsute", status: { kind: "unavailable" } });
    await expect(workspace.tree("zepsute", "")).rejects.toMatchObject({ code: "repo_unavailable" });
  });

  test("przegląd zawiera README i commity, drzewo i plik czytają z ostatniego commita", async () => {
    const { workspace, projects } = newWorkspace();
    makeRepo({ "README.md": "# Opis\n", "readme.txt": "gorszy", "src/a.ts": "kod" }, "api", projects);

    const overview = await workspace.overview("api");
    expect(Object.keys(overview).sort()).toEqual(["commits", "readme"]);
    expect(overview.readme).toEqual({ path: "README.md", text: "# Opis\n", truncated: false });
    expect(overview.commits.map((c) => c.subject)).toEqual(["pierwszy commit"]);
    expect((await workspace.tree("api", "")).map((e) => e.path)).toEqual(["src", "README.md", "readme.txt"]);
    expect(await workspace.file("api", "src/a.ts")).toMatchObject({ kind: "text", text: "kod" });
    await expect(workspace.file("api", "src")).rejects.toMatchObject({ code: "not_found" });
  });

  test("przegląd repo bez commitów nie ma README ani commitów", async () => {
    const { workspace, projects } = newWorkspace();
    makeRepo({}, "puste", projects);
    expect(await workspace.overview("puste")).toMatchObject({ readme: null, commits: [] });
  });

  test("otwarcie w VS Code przekazuje adres vscode:// z katalogiem repo", () => {
    const { workspace, projects, opened } = newWorkspace();
    const dir = makeRepo({ a: "1" }, "api", projects);
    workspace.openEditor("api");
    expect(opened).toEqual([vscodeUrl(dir)]);
  });
});

describe("vscodeUrl", () => {
  test("ścieżka z Windowsa i z macOS, znaki specjalne zakodowane", () => {
    expect(vscodeUrl("C:\\Users\\jan\\repo #1")).toBe("vscode://file/C:/Users/jan/repo%20%231");
    expect(vscodeUrl("/Users/jan/repo")).toBe("vscode://file/Users/jan/repo");
  });
});

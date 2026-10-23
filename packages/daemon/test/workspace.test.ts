import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { vscodeUrl } from "../src/modules/workspace/editor-url.ts";
import { isFullPath } from "../src/modules/workspace/projects-dir.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";

/** Workspace z ustawionym, pustym folderem z projektami. */
function workspaceWithProjectsDir() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
  const opened: string[] = [];
  const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), openUrl: (url) => opened.push(url) });
  workspace.setProjectsDir(projects);
  return { workspace, file, projects, opened };
}

describe("workspace", () => {
  test("lista to repo gita z folderu z projektami, posortowane, bez zwykłych katalogów, plików i ukrytych katalogów", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
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

  test("dowiązanie do repo (na Windowsie junction) i worktree z plikiem .git są repo, zerwane dowiązanie nie", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    // Junction na Windowsie nie wymaga uprawnień administratora; na macOS i Linuksie typ jest ignorowany.
    symlinkSync(makeRepo({ a: "1" }), join(projects, "dowiazane"), "junction");
    symlinkSync(join(projects, "nie-ma"), join(projects, "zerwane"), "junction");
    mkdirSync(join(projects, "worktree"));
    writeFileSync(join(projects, "worktree", ".git"), "gitdir: /nie/ma\n");

    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["dowiazane", "worktree"]);
  });

  test("repo sklonowane albo usunięte poza Trackwallem pojawia się i znika przy następnym zapytaniu", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    expect((await workspace.list()).repos).toEqual([]);

    const dir = makeRepo({ a: "1" }, "api", projects);
    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["api"]);

    rmSync(dir, { recursive: true, force: true });
    expect((await workspace.list()).repos).toEqual([]);
    await expect(workspace.overview("api")).rejects.toMatchObject({ code: "not_found" });
  });

  test("katalogi, których nazwy dają ten sam identyfikator, dostają przyrostki w stałej kolejności", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
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
    const { workspace, file, projects } = workspaceWithProjectsDir();
    expect(workspace.settings()).toEqual({ projectsDir: projects, configFile: file });
    expect(readFileSync(file, "utf8")).toContain(`projectsDir: ${projects}`);
  });

  test("ścieżka względna, nieistniejąca albo do pliku jest odrzucana jako bad_request i niczego nie zapisuje", () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    writeFileSync(join(projects, "plik.txt"), "x");

    expect(() => workspace.setProjectsDir("wzgledna/sciezka")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => workspace.setProjectsDir(join(projects, "nie-ma"))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => workspace.setProjectsDir(join(projects, "plik.txt"))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => workspace.setProjectsDir(join(projects, "plik.txt", "pod"))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(workspace.settings().projectsDir).toBe(projects);
  });

  test("folder, który zniknął po ustawieniu, to projects_dir_unavailable z jego ścieżką", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    rmSync(projects, { recursive: true, force: true });

    await expect(workspace.list()).rejects.toMatchObject({ code: "projects_dir_unavailable", message: expect.stringContaining(projects) });
  });

  test("repo, którego git nie czyta, zostaje na liście jako niedostępne", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });

    const [repo] = (await workspace.list()).repos;
    expect(repo).toMatchObject({ id: "zepsute", status: { kind: "unavailable" } });
    await expect(workspace.tree("zepsute", "")).rejects.toMatchObject({ code: "repo_unavailable" });
  });

  test("puste .git w folderze z projektami leżącym w innym repo nie pokazuje tamtego repo", async () => {
    const outer = makeRepo({ "a.txt": "zewnętrzne" }, "dom");
    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), openUrl: () => {} });
    mkdirSync(join(outer, "Projects", "puste", ".git"), { recursive: true });
    workspace.setProjectsDir(join(outer, "Projects"));

    expect((await workspace.list()).repos).toMatchObject([{ id: "puste", status: { kind: "unavailable" } }]);
  });

  test("core.fsmonitor z konfiguracji repo nie jest uruchamiany przy odczycie stanu", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
    const dir = makeRepo({ a: "1" }, "api", projects);
    const marker = join(projects, "fsmonitor-uruchomiony");
    gitIn(dir, "config", "core.fsmonitor", `echo x > "${marker.replaceAll("\\", "/")}"`);

    expect((await workspace.list()).repos[0]?.status.kind).toBe("ok");
    expect(existsSync(marker)).toBe(false);
  });

  test("przegląd zawiera README i commity, drzewo i plik czytają z ostatniego commita", async () => {
    const { workspace, projects } = workspaceWithProjectsDir();
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
    const { workspace, projects } = workspaceWithProjectsDir();
    makeRepo({}, "puste", projects);
    expect(await workspace.overview("puste")).toMatchObject({ readme: null, commits: [] });
  });

  test("otwarcie w VS Code przekazuje adres vscode:// z katalogiem repo", async () => {
    const { workspace, projects, opened } = workspaceWithProjectsDir();
    const dir = makeRepo({ a: "1" }, "api", projects);
    await workspace.openEditor("api");
    expect(opened).toEqual([vscodeUrl(dir)]);
  });
});

describe("isFullPath", () => {
  test("na Windowsie pełna ścieżka ma literę dysku albo jest UNC, a \\projekty zależy od bieżącego dysku", () => {
    expect(isFullPath("C:\\Users\\ja\\Projects", win32)).toBe(true);
    expect(isFullPath("\\\\serwer\\udzial\\projekty", win32)).toBe(true);
    expect(isFullPath("\\projekty", win32)).toBe(false);
    expect(isFullPath("C:projekty", win32)).toBe(false);
    expect(isFullPath("/Users/ja/Projects", posix)).toBe(true);
    expect(isFullPath("~/Projects", posix)).toBe(false);
  });
});

describe("vscodeUrl", () => {
  test("ścieżka z Windowsa i z macOS, znaki specjalne zakodowane", () => {
    expect(vscodeUrl("C:\\Users\\jan\\repo #1")).toBe("vscode://file/C:/Users/jan/repo%20%231");
    expect(vscodeUrl("/Users/jan/repo")).toBe("vscode://file/Users/jan/repo");
  });
});

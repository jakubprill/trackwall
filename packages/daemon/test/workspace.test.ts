import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { vscodeUrl } from "../src/infra/editor-url.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { isFullPath } from "../src/modules/workspace/full-path.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** A workspace with a set, empty projects folder. */
async function workspaceWithProjectsDir() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const opened: string[] = [];
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs: new Vcs(),
    hosting: fakeHosting().hosting,
    openEditor: (dir) => opened.push(dir),
    openFolder: () => {},
  });
  await workspace.setProjectsDir(projects);
  return { workspace, file, projects, opened };
}

describe("workspace", () => {
  test("the list is the git repos of the projects folder, sorted, without plain directories, files and hidden directories", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({ a: "1" }, "web", projects);
    makeRepo({ a: "1" }, "Orders BFF", projects);
    makeRepo({ a: "1" }, ".hidden", projects);
    mkdirSync(join(projects, "notes"));
    writeFileSync(join(projects, "file.txt"), "x");

    const { projectsDir, repos } = await workspace.list();

    expect(projectsDir).toBe(projects);
    expect(repos.map((r) => [r.id, r.path, r.status.kind])).toEqual([
      ["orders-bff", join(projects, "Orders BFF"), "ok"],
      ["web", join(projects, "web"), "ok"],
    ]);
  });

  test("a link to a repo (a junction on Windows) and a worktree with a .git file are repos, a broken link is not", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    // A junction on Windows does not need administrator rights; on macOS and Linux the type is ignored.
    symlinkSync(makeRepo({ a: "1" }), join(projects, "linked"), "junction");
    symlinkSync(join(projects, "missing"), join(projects, "broken"), "junction");
    mkdirSync(join(projects, "worktree"));
    writeFileSync(join(projects, "worktree", ".git"), "gitdir: /does/not/exist\n");

    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["linked", "worktree"]);
  });

  test("a repo cloned or removed outside Trackwall appears and disappears on the next query", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    expect((await workspace.list()).repos).toEqual([]);

    const dir = makeRepo({ a: "1" }, "api", projects);
    expect((await workspace.list()).repos.map((r) => r.id)).toEqual(["api"]);

    rmSync(dir, { recursive: true, force: true });
    expect((await workspace.list()).repos).toEqual([]);
    await expect(workspace.overview("api")).rejects.toMatchObject({ code: "not_found" });
  });

  test("directories whose names give the same identifier get suffixes in a fixed order", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({}, "Zażółć", projects);
    makeRepo({}, "zazolc", projects);

    expect((await workspace.list()).repos.map((r) => [r.id, r.path])).toEqual([
      ["zazolc", join(projects, "zazolc")],
      ["zazolc-2", join(projects, "Zażółć")],
    ]);
  });

  test("without a folder set the list is empty, and no repo can be opened", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const workspace = new Workspace({
      file: new WorkspaceFile(file),
      vcs: new Vcs(),
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
    });

    expect(await workspace.list()).toEqual({ projectsDir: null, repos: [] });
    expect(workspace.settings()).toEqual({ projectsDir: null, configFile: file });
    await expect(workspace.overview("api")).rejects.toMatchObject({ code: "not_found" });
    await expect(workspace.projectsDir()).rejects.toMatchObject({ code: "bad_request", message: "set the projects folder first" });
  });

  test("setting the folder saves the full path in workspace.yaml", async () => {
    const { workspace, file, projects } = await workspaceWithProjectsDir();
    expect(workspace.settings()).toEqual({ projectsDir: projects, configFile: file });
    expect(readFileSync(file, "utf8")).toContain(`projectsDir: ${projects}`);
    expect(await workspace.projectsDir()).toBe(projects);
  });

  test("a relative path, a missing one or one to a file is rejected as bad_request and saves nothing", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    writeFileSync(join(projects, "file.txt"), "x");

    await expect(workspace.setProjectsDir("relative/path")).rejects.toThrow(expect.objectContaining({ code: "bad_request" }));
    await expect(workspace.setProjectsDir(join(projects, "missing"))).rejects.toThrow(expect.objectContaining({ code: "bad_request" }));
    await expect(workspace.setProjectsDir(join(projects, "file.txt"))).rejects.toThrow(expect.objectContaining({ code: "bad_request" }));
    await expect(workspace.setProjectsDir(join(projects, "file.txt", "sub"))).rejects.toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(workspace.settings().projectsDir).toBe(projects);
  });

  test("a folder that vanished after being set is projects_dir_unavailable with its path", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    rmSync(projects, { recursive: true, force: true });

    await expect(workspace.list()).rejects.toMatchObject({ code: "projects_dir_unavailable", message: expect.stringContaining(projects) });
  });

  test("a repo git cannot read stays on the list as unavailable", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    mkdirSync(join(projects, "broken", ".git"), { recursive: true });

    const [repo] = (await workspace.list()).repos;
    expect(repo).toMatchObject({ id: "broken", status: { kind: "unavailable" } });
    await expect(workspace.tree("broken", "")).rejects.toMatchObject({ code: "repo_unavailable" });
  });

  test("an empty .git in a projects folder lying in another repo does not show that repo", async () => {
    const outer = makeRepo({ "a.txt": "outer" }, "home");
    const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
    const workspace = new Workspace({
      file: new WorkspaceFile(file),
      vcs: new Vcs(),
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
    });
    mkdirSync(join(outer, "Projects", "empty", ".git"), { recursive: true });
    await workspace.setProjectsDir(join(outer, "Projects"));

    expect((await workspace.list()).repos).toMatchObject([{ id: "empty", status: { kind: "unavailable" } }]);
  });

  test("a link to a directory with an empty .git lying in another repo does not show that repo", async () => {
    const outer = makeRepo({ "a.txt": "outer" }, "home");
    mkdirSync(join(outer, "target", ".git"), { recursive: true });
    const { workspace, projects } = await workspaceWithProjectsDir();
    symlinkSync(join(outer, "target"), join(projects, "linked"), "junction");

    expect((await workspace.list()).repos).toMatchObject([{ id: "linked", status: { kind: "unavailable" } }]);
  });

  test("another user's repo is unavailable, as in the terminal (safe.directory)", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({ a: "1" }, "foreign", projects);
    // A variable from git's tests simulates another repo owner without `chown`, which CI cannot do. Without the system,
    // global and environment configuration, because the CI runner may have `safe.directory = *` in it.
    const isolated = {
      GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
      GIT_CONFIG_GLOBAL: join(projects, "empty.gitconfig"),
    };
    writeFileSync(isolated.GIT_CONFIG_GLOBAL, "");
    const saved = Object.keys(isolated).map((name) => [name, process.env[name]] as const);
    Object.assign(process.env, isolated);
    try {
      expect((await workspace.list()).repos).toMatchObject([{ id: "foreign", status: { kind: "unavailable" } }]);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("gpg.program from the repo configuration is not run by log.showSignature", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    const dir = makeRepo({}, "api", projects);
    const marker = join(projects, "gpg-ran");
    const program = join(projects, "gpg.sh");
    writeFileSync(program, `#!/bin/sh\necho x > "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
    // A commit with a signature (the `gpgsig` header), because without it git does not call the verifying program.
    const tree = gitIn(dir, "write-tree").trim();
    const commit = execFileSync("git", ["-C", dir, "hash-object", "-t", "commit", "-w", "--stdin"], {
      input: `tree ${tree}\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned\n`,
      encoding: "utf8",
    }).trim();
    gitIn(dir, "update-ref", "refs/heads/main", commit);
    gitIn(dir, "config", "log.showSignature", "true");
    gitIn(dir, "config", "gpg.program", program.replaceAll("\\", "/"));

    expect((await workspace.list()).repos[0]?.status).toMatchObject({ kind: "ok", head: { subject: "signed" } });
    expect(existsSync(marker)).toBe(false);
  });

  test("core.fsmonitor from the repo configuration is not run when reading the state", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    const dir = makeRepo({ a: "1" }, "api", projects);
    const marker = join(projects, "fsmonitor-ran");
    gitIn(dir, "config", "core.fsmonitor", `echo x > "${marker.replaceAll("\\", "/")}"`);

    expect((await workspace.list()).repos[0]?.status.kind).toBe("ok");
    expect(existsSync(marker)).toBe(false);
  });

  test("the overview has the README and commits, the tree and file read from the last commit", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({ "README.md": "# About\n", "readme.txt": "worse", "src/a.ts": "code" }, "api", projects);

    const overview = await workspace.overview("api");
    expect(Object.keys(overview).sort()).toEqual(["commits", "readme"]);
    expect(overview.readme).toEqual({ path: "README.md", text: "# About\n", truncated: false, format: "markdown" });
    expect(overview.commits.map((c) => c.subject)).toEqual(["first commit"]);
    expect((await workspace.tree("api", "")).map((e) => e.path)).toEqual(["src", "README.md", "readme.txt"]);
    expect(await workspace.file("api", "src/a.ts")).toMatchObject({ kind: "text", text: "code" });
    await expect(workspace.file("api", "src")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a README without an extension is Markdown, and README.txt, .rst and .adoc are text", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({ README: "# About" }, "bare", projects);
    makeRepo({ "README.rst": "About\n=====" }, "rst", projects);
    makeRepo({ "readme.TXT": "About" }, "txt", projects);
    expect((await workspace.overview("bare")).readme?.format).toBe("markdown");
    expect((await workspace.overview("rst")).readme?.format).toBe("text");
    expect((await workspace.overview("txt")).readme?.format).toBe("text");
  });

  test("the overview of a repo without commits has no README and no commits", async () => {
    const { workspace, projects } = await workspaceWithProjectsDir();
    makeRepo({}, "empty", projects);
    expect(await workspace.overview("empty")).toMatchObject({ readme: null, commits: [] });
  });

  test("opening in VS Code passes a vscode:// address with the repo directory", async () => {
    const { workspace, projects, opened } = await workspaceWithProjectsDir();
    const dir = makeRepo({ a: "1" }, "api", projects);
    await workspace.openEditor("api");
    expect(opened).toEqual([dir]);
  });
});

describe("isFullPath", () => {
  test("on Windows a full path has a drive letter or is UNC, and \\projects depends on the current drive", () => {
    expect(isFullPath("C:\\Users\\me\\Projects", win32)).toBe(true);
    expect(isFullPath("\\\\server\\share\\projects", win32)).toBe(true);
    expect(isFullPath("\\projects", win32)).toBe(false);
    expect(isFullPath("C:projects", win32)).toBe(false);
    expect(isFullPath("/Users/me/Projects", posix)).toBe(true);
    expect(isFullPath("~/Projects", posix)).toBe(false);
  });
});

describe("vscodeUrl", () => {
  test("a path from Windows and from macOS, special characters encoded", () => {
    expect(vscodeUrl("C:\\Users\\jan\\repo #1")).toBe("vscode://file/C:/Users/jan/repo%20%231");
    expect(vscodeUrl("/Users/jan/repo")).toBe("vscode://file/Users/jan/repo");
  });
});

describe("the tool permissions of a session from workspace.yaml (ADR-66, ADR-78)", () => {
  test("the supervisor is denied the shell and file writes, a session in a repo is not, and supervisor.changesCode lifts it", async () => {
    const { workspace, file } = await workspaceWithProjectsDir();
    const projectsDir = readFileSync(file, "utf8");
    writeFileSync(file, `${projectsDir}toolPermissions:\n  - deny: ["shell(git push)"]\n`);

    expect(workspace.toolPermissions(null)).toEqual({ allow: [], deny: ["shell(git push)", "shell", "write"] });
    expect(workspace.toolPermissions("shop")).toEqual({ allow: [], deny: ["shell(git push)"] });

    writeFileSync(file, `${projectsDir}toolPermissions:\n  - deny: ["shell(git push)"]\nsupervisor:\n  changesCode: true\n`);
    expect(workspace.toolPermissions(null)).toEqual({ allow: [], deny: ["shell(git push)"] });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncRun } from "@trackwall/protocol";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** Workspace z pustym folderem z projektami i katalog na repo „zdalne” (lokalne repo jako remote). */
async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
  const remotes = mkdtempSync(join(tmpdir(), "trackwall-zdalne-"));
  const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), hosting: fakeHosting().hosting, openUrl: () => {} });
  await workspace.setProjectsDir(projects);
  return { workspace, projects, remotes };
}

/** Repo zdalne `name` z jednym commitem i jego klon w folderze z projektami. */
function cloned(projects: string, remotes: string, name: string): { upstream: string; clone: string } {
  const upstream = makeRepo({ "README.md": `# ${name}\n` }, name, remotes);
  gitIn(projects, "clone", "-q", upstream, name);
  return { upstream, clone: join(projects, name) };
}

const head = (dir: string, ref = "HEAD") => gitIn(dir, "rev-parse", ref).trim();

async function finished(workspace: Workspace): Promise<SyncRun> {
  for (let i = 0; i < 400; i++) {
    const run = workspace.syncRun();
    if (run?.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("synchronizacja nie skończyła się w czasie testu");
}

describe("synchronizacja wszystkich repo", () => {
  test("wybrana, czysta gałąź domyślna przesuwa się do zdalnej razem z plikami, a aktualna zostaje", async () => {
    const { workspace, projects, remotes } = await setup();
    const api = cloned(projects, remotes, "api");
    const web = cloned(projects, remotes, "web");
    commitFiles(api.upstream, { "nowy.txt": "1" }, "pierwszy zdalny");
    commitFiles(api.upstream, { "drugi.txt": "2" }, "drugi zdalny");

    const started = await workspace.sync();
    expect(started.finishedAt).toBeNull();
    expect(started.repos.map((r) => r.repo)).toEqual(["api", "web"]);
    const run = await finished(workspace);

    expect(run.repos).toEqual([
      { repo: "api", path: api.clone, state: "updated", branch: "main", commits: 2 },
      { repo: "web", path: web.clone, state: "up-to-date", branch: "main" },
    ]);
    expect(head(api.clone)).toBe(head(api.upstream));
    expect(existsSync(join(api.clone, "drugi.txt"))).toBe(true);
  });

  test("gałąź domyślna niewybrana przesuwa się bez zmiany wybranej gałęzi i katalogu roboczego", async () => {
    const { workspace, projects, remotes } = await setup();
    const { upstream, clone } = cloned(projects, remotes, "api");
    gitIn(clone, "switch", "-q", "-c", "funkcja");
    writeFileSync(join(clone, "README.md"), "zmiana w toku\n");
    commitFiles(upstream, { "nowy.txt": "1" }, "zdalny");

    const run = await workspace.sync().then(() => finished(workspace));

    expect(run.repos[0]).toMatchObject({ state: "updated", branch: "main", commits: 1 });
    expect(head(clone, "refs/heads/main")).toBe(head(upstream));
    expect(gitIn(clone, "branch", "--show-current").trim()).toBe("funkcja");
    expect(existsSync(join(clone, "nowy.txt"))).toBe(false);
  });

  test("zmiany w wybranej gałęzi, rozjechana i niewypchnięta gałąź zostają nietknięte z powodem", async () => {
    const { workspace, projects, remotes } = await setup();
    const dirty = cloned(projects, remotes, "brudne");
    const diverged = cloned(projects, remotes, "rozjechane");
    const ahead = cloned(projects, remotes, "wypchnij");
    for (const r of [dirty, diverged]) commitFiles(r.upstream, { "nowy.txt": "1" }, "zdalny");
    writeFileSync(join(dirty.clone, "README.md"), "lokalna zmiana\n");
    for (const r of [diverged, ahead]) commitFiles(r.clone, { "lokalny.txt": "1" }, "lokalny");
    const before = [dirty, diverged, ahead].map((r) => head(r.clone));

    const run = await workspace.sync().then(() => finished(workspace));

    expect(run.repos.map((r) => (r.state === "skipped" ? r.reason : r.state))).toEqual(["dirty", "diverged", "ahead"]);
    expect(run.repos[0]).toMatchObject({ message: "main jest wybrana i ma niezacommitowane zmiany" });
    expect([dirty, diverged, ahead].map((r) => head(r.clone))).toEqual(before);
  });

  test("nieśledzony plik nie blokuje synchronizacji, ale git nie nadpisuje go plikiem ze zdalnej", async () => {
    const { workspace, projects, remotes } = await setup();
    const { upstream, clone } = cloned(projects, remotes, "api");
    writeFileSync(join(clone, "notatka.txt"), "moje");
    commitFiles(upstream, { "inny.txt": "1" }, "zdalny");
    let run = await workspace.sync().then(() => finished(workspace));
    expect(run.repos[0]).toMatchObject({ state: "updated", commits: 1 });

    commitFiles(upstream, { "notatka.txt": "zdalna" }, "zdalny z tym samym plikiem");
    run = await workspace.sync().then(() => finished(workspace));
    expect(run.repos[0]).toMatchObject({ state: "failed" });
    expect(gitIn(clone, "status", "--porcelain")).toContain("notatka.txt");
  });

  test("gałąź wybrana w innym worktree i brak lokalnej gałęzi domyślnej są pomijane", async () => {
    const { workspace, projects, remotes } = await setup();
    const other = cloned(projects, remotes, "worktree");
    gitIn(other.clone, "switch", "-q", "-c", "funkcja");
    gitIn(other.clone, "worktree", "add", "-q", join(remotes, "worktree-main"), "main");
    const missing = cloned(projects, remotes, "bez-main");
    gitIn(missing.clone, "branch", "-q", "-m", "main", "inna");
    for (const r of [other, missing]) commitFiles(r.upstream, { "nowy.txt": "1" }, "zdalny");

    const run = await workspace.sync().then(() => finished(workspace));

    expect(run.repos.map((r) => [r.repo, r.state === "skipped" ? r.reason : r.state])).toEqual([
      ["bez-main", "no-local-branch"],
      ["worktree", "checked-out-elsewhere"],
    ]);
  });

  test("repo bez origin jest pomijane, a gałąź domyślną remote bez HEAD daemon ustala sam", async () => {
    const { workspace, projects, remotes } = await setup();
    makeRepo({ a: "1" }, "lokalne", projects);
    const upstream = makeRepo({ a: "1" }, "zdalne", remotes);
    const added = makeRepo({}, "dodane", projects);
    gitIn(added, "remote", "add", "origin", upstream);

    const run = await workspace.sync().then(() => finished(workspace));

    expect(run.repos.map((r) => [r.repo, r.state === "skipped" ? r.reason : r.state])).toEqual([
      ["dodane", "no-local-branch"],
      ["lokalne", "no-remote"],
    ]);
    expect(gitIn(added, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe("refs/remotes/origin/main");
  });

  test("nieudany fetch jednego repo jest jego wynikiem i nie zatrzymuje pozostałych", async () => {
    const { workspace, projects, remotes } = await setup();
    const gone = cloned(projects, remotes, "a-zniknelo");
    const ok = cloned(projects, remotes, "b-dziala");
    rmSync(gone.upstream, { recursive: true, force: true });
    commitFiles(ok.upstream, { "nowy.txt": "1" }, "zdalny");

    const run = await workspace.sync().then(() => finished(workspace));

    expect(run.repos[0]).toMatchObject({ repo: "a-zniknelo", state: "failed", message: expect.stringContaining("a-zniknelo") });
    expect(run.repos[1]).toMatchObject({ repo: "b-dziala", state: "updated" });
  });

  test("drugie żądanie w trakcie zwraca trwającą synchronizację, a bez folderu z projektami nie ma czego synchronizować", async () => {
    const { workspace, projects, remotes } = await setup();
    expect(workspace.syncRun()).toBeNull();
    cloned(projects, remotes, "api");

    const [first, second] = await Promise.all([workspace.sync(), workspace.sync()]);
    expect(second.startedAt).toBe(first.startedAt);
    await finished(workspace);

    const empty = new Workspace({
      file: new WorkspaceFile(join(mkdtempSync(join(tmpdir(), "trackwall-ws-")), "workspace.yaml")),
      vcs: new Vcs(),
      hosting: fakeHosting().hosting,
      openUrl: () => {},
    });
    await expect(empty.sync()).rejects.toMatchObject({ code: "bad_request" });
    expect(empty.syncRun()).toBeNull();
  });

  test("lista repo podaje adres origin jako identyfikator obok nazwy katalogu", async () => {
    const { workspace, projects, remotes } = await setup();
    const { clone } = cloned(projects, remotes, "api");
    makeRepo({ a: "1" }, "bez-remote", projects);
    gitIn(clone, "remote", "set-url", "origin", "git@gitlab.example.com:sklep/Orders-API.git");

    const { repos } = await workspace.list();

    expect(repos.map((r) => [r.id, r.remote])).toEqual([
      ["api", "gitlab.example.com/sklep/Orders-API"],
      ["bez-remote", null],
    ]);
  });
});

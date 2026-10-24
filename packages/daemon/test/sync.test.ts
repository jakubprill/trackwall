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
  const workspace = new Workspace({
    file: new WorkspaceFile(file),
    vcs: new Vcs(),
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
  });
  await workspace.setProjectsDir(projects);
  return { workspace, projects, remotes };
}

/** Repo zdalne `name` z jednym commitem i jego klon w folderze z projektami. */
function cloned(projects: string, remotes: string, name: string): { upstream: string; clone: string } {
  const upstream = makeRepo({ "README.md": `# ${name}\n` }, name, remotes);
  gitIn(projects, "clone", "-q", upstream, name);
  return { upstream, clone: join(projects, name) };
}

/** Każdy test uruchamia kilkadziesiąt procesów gita, a na Windowsie w CI jeden trwa nawet 100 ms. */
const GIT_HEAVY_MS = 30_000;

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
  test(
    "wybrana, czysta gałąź domyślna przesuwa się do zdalnej razem z plikami, a aktualna zostaje; wynik mówi, co jest w katalogu roboczym",
    async () => {
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
      expect(existsSync(join(api.clone, "drugi.txt"))).toBe(true);
    },
    GIT_HEAVY_MS,
  );

  test(
    "synchronizacja jednego repo po identyfikatorze przesuwa tylko to repo, a nieznane repo to not_found",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const api = cloned(projects, remotes, "api");
      const web = cloned(projects, remotes, "web");
      commitFiles(api.upstream, { "nowy.txt": "1" }, "zdalny w api");
      commitFiles(web.upstream, { "nowy.txt": "1" }, "zdalny w web");
      const webBefore = head(web.clone);

      expect(await workspace.syncRepo("api")).toMatchObject({ state: "updated", branch: "main", commits: 1 });

      expect(head(api.clone)).toBe(head(api.upstream));
      expect(head(web.clone)).toBe(webBefore);
      await expect(workspace.syncRepo("nie-ma")).rejects.toMatchObject({ code: "not_found" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "gałąź domyślna niewybrana przesuwa się bez zmiany wybranej gałęzi i katalogu roboczego",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      gitIn(clone, "switch", "-q", "-c", "funkcja");
      writeFileSync(join(clone, "README.md"), "zmiana w toku\n");
      commitFiles(upstream, { "nowy.txt": "1" }, "zdalny");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({
        state: "updated",
        branch: "main",
        commits: 1,
        workingTree: { branch: "funkcja", changed: 1, untracked: 0 },
      });
      expect(head(clone, "refs/heads/main")).toBe(head(upstream));
      expect(gitIn(clone, "branch", "--show-current").trim()).toBe("funkcja");
      expect(existsSync(join(clone, "nowy.txt"))).toBe(false);
    },
    GIT_HEAVY_MS,
  );

  test(
    "zmiany w wybranej gałęzi, rozjechana i niewypchnięta gałąź zostają nietknięte z powodem",
    async () => {
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
    "nieśledzony plik nie blokuje synchronizacji, ale git nie nadpisuje go plikiem ze zdalnej",
    async () => {
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
    },
    GIT_HEAVY_MS,
  );

  test(
    "aktualne repo ze zmienionymi i nowymi plikami podaje je osobno, a synchronizacja ich nie rusza",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { clone } = cloned(projects, remotes, "api");
      writeFileSync(join(clone, "README.md"), "lokalna zmiana\n");
      writeFileSync(join(clone, "notatka.txt"), "moje");
      writeFileSync(join(clone, "szkic.txt"), "moje");

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
    "gałąź wybrana w innym worktree i brak lokalnej gałęzi domyślnej są pomijane",
    async () => {
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
    },
    GIT_HEAVY_MS,
  );

  test(
    "gałąź domyślna w trakcie bisect zostaje nietknięta, choć HEAD jest odłączony",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      commitFiles(upstream, { "a.txt": "1" }, "drugi");
      commitFiles(upstream, { "b.txt": "2" }, "trzeci");
      gitIn(clone, "pull", "-q", "--ff-only");
      commitFiles(upstream, { "nowy.txt": "1" }, "zdalny");
      // Bisect odłącza HEAD, ale gałąź, z której zaczął, wraca po `bisect reset`, więc git traktuje ją jak wybraną.
      gitIn(clone, "bisect", "start", "main", "main~2");
      const before = head(clone, "refs/heads/main");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ state: "failed" });
      expect(head(clone, "refs/heads/main")).toBe(before);
    },
    GIT_HEAVY_MS,
  );

  test(
    "repo i jego worktree w folderze z projektami synchronizują się po kolei, bez błędu blokady refów",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { upstream, clone } = cloned(projects, remotes, "api");
      gitIn(clone, "worktree", "add", "-q", "-b", "funkcja", join(projects, "api-funkcja"));
      commitFiles(upstream, { "nowy.txt": "1" }, "zdalny");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos.map((r) => r.repo)).toEqual(["api", "api-funkcja"]);
      expect(run.repos.filter((r) => r.state === "failed")).toEqual([]);
      expect(head(clone)).toBe(head(upstream));
    },
    GIT_HEAVY_MS,
  );

  test(
    "po zmianie gałęzi domyślnej w hostingu i usunięciu starej daemon pyta serwer o nową",
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
    "remote bez żadnej gałęzi nie ma gałęzi domyślnej",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const empty = makeRepo({}, "puste", remotes);
      gitIn(projects, "clone", "-q", empty, "puste");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ state: "skipped", reason: "no-default-branch" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "repo bez origin jest pomijane, a gałąź domyślną remote bez HEAD daemon ustala sam",
    async () => {
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
    },
    GIT_HEAVY_MS,
  );

  test(
    "nieudany fetch jednego repo jest jego wynikiem i nie zatrzymuje pozostałych",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const gone = cloned(projects, remotes, "a-zniknelo");
      const ok = cloned(projects, remotes, "b-dziala");
      rmSync(gone.upstream, { recursive: true, force: true });
      commitFiles(ok.upstream, { "nowy.txt": "1" }, "zdalny");

      const run = await workspace.sync().then(() => finished(workspace));

      expect(run.repos[0]).toMatchObject({ repo: "a-zniknelo", state: "failed", message: expect.stringContaining("a-zniknelo") });
      expect(run.repos[1]).toMatchObject({ repo: "b-dziala", state: "updated" });
    },
    GIT_HEAVY_MS,
  );

  test(
    "drugie żądanie w trakcie zwraca trwającą synchronizację, a bez folderu z projektami nie ma czego synchronizować",
    async () => {
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
        openEditor: () => {},
        openFolder: () => {},
      });
      await expect(empty.sync()).rejects.toMatchObject({ code: "bad_request" });
      expect(empty.syncRun()).toBeNull();
    },
    GIT_HEAVY_MS,
  );

  test(
    "lista repo podaje adres origin jako identyfikator obok nazwy katalogu",
    async () => {
      const { workspace, projects, remotes } = await setup();
      const { clone } = cloned(projects, remotes, "api");
      makeRepo({ a: "1" }, "bez-remote", projects);
      gitIn(clone, "remote", "set-url", "origin", "git@gitlab.example.com:sklep/Orders-API.git");

      const { repos } = await workspace.list();

      expect(repos.map((r) => [r.id, r.remote])).toEqual([
        ["api", "gitlab.example.com/sklep/Orders-API"],
        ["bez-remote", null],
      ]);
    },
    GIT_HEAVY_MS,
  );
});

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agents } from "../src/modules/agents/agents.ts";
import { TASK_BRANCH_PREFIX } from "../src/modules/agents/task-branch.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Klon repo z `main` (jak z hostingu: z `origin/HEAD`), w którym użytkownik pracuje na gałęzi `funkcja`. */
function cloneOnFeatureBranch(): { dir: string; mainCommit: string } {
  const origin = makeRepo({ "README.md": "# sklep\n", "src/login.ts": "export const login = 1;\n" }, "sklep-origin");
  const dir = join(mkdtempSync(join(tmpdir(), "trackwall-projects-")), "sklep");
  gitIn(origin, "clone", "-q", origin, dir);
  const mainCommit = gitIn(dir, "rev-parse", "HEAD").trim();
  gitIn(dir, "switch", "-q", "-c", "funkcja");
  commitFiles(dir, { "src/funkcja.ts": "export const x = 1;\n" }, "praca użytkownika");
  return { dir, mainCommit };
}

/** Jedyna sesja zadania; zadanie nie zna swojej sesji, to sesja wskazuje zadanie. */
function sessionOf(agents: Agents, task: string): string {
  const [session, ...more] = agents.sessions().sessions.filter((s) => s.task === task);
  if (!session || more.length > 0) throw new Error(`zadanie ${task} nie ma dokładnie jednej sesji`);
  return session.id;
}

describe.skipIf(process.versions.bun === undefined)("zadania agenta w worktree (prawdziwy git i PTY, atrapa Copilot CLI)", () => {
  test("zadanie dostaje gałąź od gałęzi domyślnej w worktree poza repo, a Copilot CLI startuje w nim z poleceniem", async () => {
    const { dir, mainCommit } = cloneOnFeatureBranch();
    const { agents, procs, home } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("sklep", "Napraw logowanie w sklepie");
    expect(task).toMatchObject({ repo: "sklep", prompt: "Napraw logowanie w sklepie", baseBranch: "main", base: mainCommit });
    expect(task.branch).toMatch(/^trackwall\/napraw-logowanie-w-sklepie-[0-9a-f]{6}$/);
    expect(task.worktree).toBe(join(home, "worktrees", "sklep", task.branch.slice("trackwall/".length)));
    expect(gitIn(task.worktree, "branch", "--show-current").trim()).toBe(task.branch);
    expect(existsSync(join(task.worktree, "src", "funkcja.ts"))).toBe(false);
    expect(gitIn(dir, "branch", "--show-current").trim()).toBe("funkcja");

    const session = sessionOf(agents, task.id);
    expect(agents.sessions().sessions.find((s) => s.id === session)).toMatchObject({
      repo: "sklep",
      task: task.id,
      run: { kind: "running" },
    });
    const window = viewer(agents, session);
    await waitFor(agents, session, () => window.text().includes("--interactive="), "polecenie na ekranie");
    // Proces widzi katalog po rozwinięciu dowiązań (na macOS `/var` to `/private/var`).
    expect(window.text()).toContain(`katalog ${realpathSync(task.worktree)}`);
    expect(window.text()).toContain("Argument: --interactive=Napraw logowanie w sklepie");
    expect(window.text()).toContain(`Argument: --session-id=${task.id}`);
    window.attachment.detach();
  }, 60_000);

  test("zmiany zadania to commity i niezacommitowane pliki, także nowe, a indeks worktree zostaje nietknięty", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "dodaj wylogowanie");

    commitFiles(task.worktree, { "src/logout.ts": "export const logout = 1;\n" }, "wylogowanie");
    writeFileSync(join(task.worktree, "src", "login.ts"), "export const login = 2;\n");
    writeFileSync(join(task.worktree, "notatki.md"), "plan\n");

    const changes = await agents.taskChanges(task.id);
    expect(changes.files).toEqual([
      { path: "notatki.md", change: "added", additions: 1, deletions: 0 },
      { path: "src/login.ts", change: "modified", additions: 1, deletions: 1 },
      { path: "src/logout.ts", change: "added", additions: 1, deletions: 0 },
    ]);
    expect(changes).toMatchObject({ commits: 1, uncommitted: 2, truncated: false });
    expect(changes.patch).toContain("+export const login = 2;");
    expect(changes.patch).toContain("+plan");
    expect(gitIn(task.worktree, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M src/login.ts", "?? notatki.md"]);
  }, 60_000);

  test("zadania z działającą sesją nie da się usunąć, a niezacommitowane zmiany przepadają tylko po potwierdzeniu", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "popraw README");
    writeFileSync(join(task.worktree, "README.md"), "# sklep po zmianie\n");

    await expect(agents.removeTask(task.id, true, false)).rejects.toThrow("ma działającą sesję");
    await agents.stop(sessionOf(agents, task.id));
    await expect(agents.removeTask(task.id, true, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: "zakończenie skasowałoby: niezacommitowane zmiany w worktree (1)",
    });
    expect(existsSync(join(task.worktree, "README.md"))).toBe(true);

    await agents.removeTask(task.id, true, true);
    expect(agents.sessions()).toMatchObject({ sessions: [], tasks: [] });
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).not.toBe("");
    expect(gitIn(dir, "worktree", "list")).not.toContain(task.worktree);
  }, 60_000);

  test("zakończenie zadania razem z gałęzią kasuje commity zadania tylko po potwierdzeniu", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "--yolo dodaj test");
    expect(task.branch).toMatch(/^trackwall\/yolo-dodaj-test-[0-9a-f]{6}$/);
    commitFiles(task.worktree, { "test/login.test.ts": "test\n" }, "test");
    await agents.stop(sessionOf(agents, task.id));

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: `zakończenie skasowałoby: commity na gałęzi ${task.branch} (1)`,
    });
    await agents.removeTask(task.id, false, true);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).toBe("");
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("zadanie przeżywa restart daemona, a wznowienie uruchamia Copilot CLI z rozmową zadania w jego worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    const first = makeAgents({ sklep: dir });
    const task = await first.agents.createTask("sklep", "napraw build");
    await first.agents.stop(sessionOf(first.agents, task.id));

    const restarted = makeAgents({ sklep: dir }, first.home);
    cleanups.push(() => restarted.procs.stopAll());
    expect(restarted.agents.sessions()).toEqual({ sessions: [], tasks: [task], worktreesDir: join(first.home, "worktrees") });

    expect(await restarted.agents.resumeTask(task.id)).toEqual(task);
    await expect(restarted.agents.resumeTask(task.id)).rejects.toThrow("ma działającą sesję");
    const session = sessionOf(restarted.agents, task.id);
    const window = viewer(restarted.agents, session);
    await waitFor(restarted.agents, session, () => window.text().includes("--resume="), "wznowienie na ekranie");
    expect(window.text()).toContain(`Argument: --resume=${task.id}`);
    // Proces widzi katalog po rozwinięciu dowiązań (na macOS `/var` to `/private/var`).
    expect(window.text()).toContain(`katalog ${realpathSync(task.worktree)}`);
    expect(window.text()).not.toContain("--interactive=");
    window.attachment.detach();

    restarted.agents.openTaskEditor(task.id);
    expect(restarted.opened).toEqual([task.worktree]);
  }, 60_000);

  test("zadanie w repo bez commitów to błąd repo, bez worktree i bez wpisu na liście", async () => {
    const empty = makeRepo({}, "puste");
    const { agents, home } = makeAgents({ puste: empty });
    await expect(agents.createTask("puste", "cokolwiek")).rejects.toMatchObject({ code: "repo_unavailable" });
    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(join(home, "worktrees", "puste"))).toBe(false);
  });
  test("dwa zadania naraz w jednym repo dostają osobne gałęzie i worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());

    const [a, b] = await Promise.all([agents.createTask("sklep", "napraw logowanie"), agents.createTask("sklep", "napraw logowanie")]);
    expect(a.branch).not.toBe(b.branch);
    const listed = gitIn(dir, "worktree", "list", "--porcelain");
    expect(listed).toContain(`branch refs/heads/${a.branch}`);
    expect(listed).toContain(`branch refs/heads/${b.branch}`);
    expect(
      agents
        .sessions()
        .tasks.map((t) => t.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  }, 60_000);

  test("polecenie ze znakami powłoki i myślnikiem na początku dociera do Copilot CLI dosłownie, jako jeden argument", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const prompt = '-x napraw "logowanie" & echo %PATH% $HOME';

    const task = await agents.createTask("sklep", prompt);
    const session = sessionOf(agents, task.id);
    const window = viewer(agents, session);
    await waitFor(agents, session, () => window.text().includes("--interactive="), "polecenie na ekranie");
    expect(window.text()).toContain(`Argument: --interactive=${prompt}`);
    window.attachment.detach();
  }, 60_000);

  test("commity z odłączonego HEAD w worktree blokują zakończenie także przy zostawieniu gałęzi", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "eksperyment");
    await agents.stop(sessionOf(agents, task.id));
    gitIn(task.worktree, "switch", "-q", "--detach");
    commitFiles(task.worktree, { "eksperyment.md": "x\n" }, "eksperyment");

    await expect(agents.removeTask(task.id, true, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: "zakończenie skasowałoby: commity poza gałęzią, z odłączonego HEAD (1)",
    });
    await agents.removeTask(task.id, true, true);
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("katalog worktree, którego git już nie zna (np. po przerwanym usuwaniu), znika dopiero po potwierdzeniu", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "przerwane usuwanie");
    await agents.stop(sessionOf(agents, task.id));
    // Tak zostawia worktree `git worktree remove`, któremu Windows nie pozwolił skasować trzymanego pliku.
    rmSync(join(dir, ".git", "worktrees", task.branch.slice(TASK_BRANCH_PREFIX.length)), { recursive: true });

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: `zakończenie skasowałoby: katalog ${task.worktree} z całą zawartością, bo git go nie zna jako worktree (przerwane usuwanie albo repo przeniesione lub usunięte)`,
    });
    expect(existsSync(task.worktree)).toBe(true);
    await agents.removeTask(task.id, false, true);
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).toBe("");
    expect(agents.sessions().tasks).toEqual([]);
  }, 60_000);

  test("zadanie, którego repo zniknęło, kończy się razem z katalogiem worktree tylko po potwierdzeniu", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "repo zniknie");
    await agents.stop(sessionOf(agents, task.id));
    renameSync(dir, `${dir}-przeniesione`);

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({ code: "unsaved_changes" });
    expect(existsSync(task.worktree)).toBe(true);
    await agents.removeTask(task.id, false, true);
    expect(agents.sessions().tasks).toEqual([]);
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);
  test("zakończenie czeka na trwające liczenia zmian z kilku okien, a nowe liczenie w jego trakcie odmawia", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "dwa okna");
    await agents.stop(sessionOf(agents, task.id));
    writeFileSync(join(task.worktree, "nowy.md"), "x\n");

    const reads = [agents.taskChanges(task.id), agents.taskChanges(task.id)];
    const removal = agents.removeTask(task.id, false, true);
    expect(() => agents.taskChanges(task.id)).toThrow("zadanie jest właśnie kończone");
    for (const read of await Promise.all(reads)) expect(read.files.map((f) => f.path)).toEqual(["nowy.md"]);
    await removal;
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("uszkodzony indeks worktree to błąd zmian zadania, a nie diff bez nowych plików", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "zepsuty indeks");
    writeFileSync(gitIn(task.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index").trim(), "to nie jest indeks");

    await expect(agents.taskChanges(task.id)).rejects.toMatchObject({ code: "repo_unavailable" });
  }, 60_000);
});

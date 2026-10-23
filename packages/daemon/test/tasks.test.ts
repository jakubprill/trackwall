import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const session = agents.sessions().sessions.find((s) => s.id === task.session);
    expect(session).toMatchObject({ repo: "sklep", task: task.id, run: { kind: "running" } });
    const window = viewer(agents, task.session ?? "");
    await waitFor(agents, task.session ?? "", () => window.text().includes("--interactive="), "polecenie na ekranie");
    expect(window.text()).toContain(`katalog ${task.worktree}`);
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
    await agents.stop(task.session ?? "");
    await expect(agents.removeTask(task.id, true, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: "usunięcie skasowałoby: niezacommitowane zmiany w worktree (1)",
    });
    expect(existsSync(join(task.worktree, "README.md"))).toBe(true);

    const after = await agents.removeTask(task.id, true, true);
    expect(after).toMatchObject({ sessions: [], tasks: [] });
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).not.toBe("");
    expect(gitIn(dir, "worktree", "list")).not.toContain(task.worktree);
  }, 60_000);

  test("usunięcie zadania razem z gałęzią kasuje commity zadania tylko po potwierdzeniu", async () => {
    const { dir } = cloneOnFeatureBranch();
    const { agents, procs } = makeAgents({ sklep: dir });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("sklep", "--yolo dodaj test");
    expect(task.branch).toMatch(/^trackwall\/yolo-dodaj-test-[0-9a-f]{6}$/);
    commitFiles(task.worktree, { "test/login.test.ts": "test\n" }, "test");
    await agents.stop(task.session ?? "");

    await expect(agents.removeTask(task.id, false, false)).rejects.toMatchObject({
      code: "unsaved_changes",
      message: `usunięcie skasowałoby: commity na gałęzi ${task.branch} (1)`,
    });
    await agents.removeTask(task.id, false, true);
    expect(gitIn(dir, "branch", "--list", task.branch).trim()).toBe("");
    expect(existsSync(task.worktree)).toBe(false);
  }, 60_000);

  test("zadanie przeżywa restart daemona, a wznowienie uruchamia Copilot CLI z rozmową zadania w jego worktree", async () => {
    const { dir } = cloneOnFeatureBranch();
    const first = makeAgents({ sklep: dir });
    const task = await first.agents.createTask("sklep", "napraw build");
    await first.agents.stop(task.session ?? "");

    const restarted = makeAgents({ sklep: dir }, first.home);
    cleanups.push(() => restarted.procs.stopAll());
    expect(restarted.agents.sessions()).toEqual({
      sessions: [],
      tasks: [{ ...task, session: null }],
      worktreesDir: join(first.home, "worktrees"),
    });

    const resumed = await restarted.agents.resumeTask(task.id);
    expect(resumed.session).not.toBeNull();
    await expect(restarted.agents.resumeTask(task.id)).rejects.toThrow("ma działającą sesję");
    const window = viewer(restarted.agents, resumed.session ?? "");
    await waitFor(restarted.agents, resumed.session ?? "", () => window.text().includes("--resume="), "wznowienie na ekranie");
    expect(window.text()).toContain(`Argument: --resume=${task.id}`);
    expect(window.text()).toContain(`katalog ${task.worktree}`);
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
});

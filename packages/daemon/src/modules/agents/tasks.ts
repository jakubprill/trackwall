import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session, Task, WorktreeChanges } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../errors.ts";
import { TASK_BRANCH_PREFIX, taskSlug } from "./task-branch.ts";
import type { StoredTask, TaskFile } from "./task-file.ts";

/**
 * Zadania agentów (§4.4, ADR-31): polecenie dla Copilot CLI w osobnym worktree na nowej gałęzi od gałęzi domyślnej
 * repo, więc kilka zadań w jednym repo nie wchodzi sobie w drogę ani w katalog roboczy użytkownika. Zadanie
 * przeżywa restart daemona (`tasks.json`), a jego sesja nie; worktree i gałąź znikają tylko na prośbę użytkownika,
 * a zmiany, które by przy tym przepadły, tylko po jego potwierdzeniu.
 */

/** Diff zadania w UI: więcej i tak nikt nie przewija. */
const PATCH_MAX_BYTES = 1024 * 1024;

/** Czego zadania potrzebują od `vcs` (worktree i gałęzie, ADR-31); podłączane w fasadzie. */
export interface TasksVcs {
  defaultBase(dir: string): Promise<{ branch: string | null; commit: string }>;
  addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  pendingWork(work: { repoDir: string; worktree: string; branch: string; base: string }): Promise<{ uncommitted: number; commits: number }>;
  worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<WorktreeChanges>;
}

/** Sesje Copilot CLI z `Agents`, w których działają zadania. */
interface TaskSessions {
  /** Copilot CLI w worktree zadania z argumentami zadania (polecenie albo wznowienie). */
  launch(spec: { repo: string; cwd: string; task: string; args: readonly string[] }): Promise<Session>;
  /** Sesje zadania od najnowszej. */
  of(task: string): Session[];
  /** Usuwa zakończoną sesję z listy. */
  close(session: string): void;
}

export interface AgentTasksDeps {
  vcs: TasksVcs;
  repos: { repoPath(id: string): Promise<string> };
  sessions: TaskSessions;
  file: TaskFile;
  /** Katalog worktree zadań w katalogu stanu; poza folderem z projektami, więc lista repo ich nie widzi. */
  worktreesDir: string;
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

export class AgentTasks {
  readonly #deps: AgentTasksDeps;
  /** Od najnowszego. */
  #tasks: StoredTask[];
  /** Zadania, na których trwa akcja (start, wznowienie, usunięcie); druga naraz to `bad_request`. */
  readonly #busy = new Set<string>();

  constructor(deps: AgentTasksDeps) {
    this.#deps = deps;
    this.#tasks = deps.file.read();
  }

  /** Zadania z ostatnią sesją każdego z `sessions` (od najnowszej). */
  list(sessions: readonly Session[]): Task[] {
    return this.#tasks.map((task) => view(task, sessions.find((s) => s.task === task.id)?.id ?? null));
  }

  /** Worktree na nowej gałęzi od gałęzi domyślnej i Copilot CLI w nim z poleceniem jako pierwszą wiadomością. */
  async create(repo: string, prompt: string): Promise<Task> {
    const repoDir = await this.#deps.repos.repoPath(repo);
    const base = await this.#deps.vcs.defaultBase(repoDir).catch((err: unknown) => {
      throw new DomainError("repo_unavailable", `${repo}: ${messageOf(err)}`);
    });
    const id = randomUUID();
    const slug = taskSlug(prompt, id);
    const task: StoredTask = {
      id,
      repo,
      repoDir,
      prompt,
      branch: `${TASK_BRANCH_PREFIX}${slug}`,
      baseBranch: base.branch,
      base: base.commit,
      worktree: join(this.#deps.worktreesDir, repo, slug),
      createdAt: new Date().toISOString(),
    };
    return this.#exclusive(id, async () => {
      mkdirSync(dirname(task.worktree), { recursive: true });
      await this.#deps.vcs.addWorktree(repoDir, task.worktree, task.branch, task.base).catch((err: unknown) => {
        throw new DomainError("repo_unavailable", `${repo}: ${messageOf(err)}`);
      });
      // Zapis przed startem sesji: worktree już jest na dysku i nie może zniknąć z listy, gdy daemon padnie.
      this.#save([task, ...this.#tasks]);
      try {
        // `=` zamiast osobnego argumentu, żeby polecenie zaczynające się od `-` nie było opcją Copilot CLI.
        await this.#launch(task, [`--session-id=${id}`, `--interactive=${prompt}`]);
      } catch (err) {
        // Nieudane sprzątanie zostawia zadanie na liście, żeby użytkownik mógł je usunąć sam.
        await this.#discard(task, false).then(
          () => this.#save(this.#tasks.filter((t) => t.id !== id)),
          (e: unknown) => this.#deps.log(`sprzątanie zadania ${id}: ${messageOf(e)}`),
        );
        throw err;
      }
      return view(task, this.#latestSession(id));
    });
  }

  /** Nowa sesja zadania bez działającej sesji; Copilot CLI wznawia rozmowę zadania, bo ma ona UUID zadania. */
  resume(id: string): Promise<Task> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "wznowieniem");
      this.#closeSessions(task);
      await this.#launch(task, [`--resume=${id}`]);
      return view(task, this.#latestSession(id));
    });
  }

  changes(id: string): Promise<WorktreeChanges> {
    const task = this.#existingWorktree(id);
    return this.#deps.vcs.worktreeChanges(task.worktree, task.base, PATCH_MAX_BYTES).catch((err: unknown) => {
      throw new DomainError("repo_unavailable", `${task.branch}: ${messageOf(err)}`);
    });
  }

  openEditor(id: string): void {
    this.#deps.openEditor(this.#existingWorktree(id).worktree);
  }

  /**
   * Usuwa worktree zadania, a bez `keepBranch` także gałąź. Niezacommitowane pliki, a przy usuwaniu gałęzi także
   * commity zadania, przepadają tylko z `discardChanges`; inaczej `unsaved_changes` z tym, co by przepadło.
   */
  remove(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "usunięciem");
      if (!existsSync(task.repoDir)) {
        // Bez repo nie ma gita, który usunąłby worktree i gałąź; zadanie znika z listy, a pliki zostają.
        this.#deps.log(`zadanie ${id}: repo ${task.repoDir} nie istnieje, zostaje usunięte tylko z listy (worktree ${task.worktree})`);
      } else {
        if (!discardChanges) await this.#refuseLoss(task, keepBranch);
        await this.#discard(task, keepBranch);
      }
      this.#closeSessions(task);
      this.#save(this.#tasks.filter((t) => t.id !== id));
    });
  }

  async #refuseLoss(task: StoredTask, keepBranch: boolean): Promise<void> {
    const { uncommitted, commits } = await this.#git(task, () => this.#deps.vcs.pendingWork(task));
    const lost = [
      uncommitted > 0 && `niezacommitowane zmiany w worktree (${uncommitted})`,
      !keepBranch && commits > 0 && `commity na gałęzi ${task.branch} (${commits})`,
    ].filter((s) => s !== false);
    if (lost.length > 0) throw new DomainError("unsaved_changes", `usunięcie skasowałoby: ${lost.join(", ")}`);
  }

  /** Worktree (z niezacommitowanymi zmianami) i, bez `keepBranch`, gałąź. */
  async #discard(task: StoredTask, keepBranch: boolean): Promise<void> {
    await this.#git(task, async () => {
      await this.#deps.vcs.removeWorktree(task.repoDir, task.worktree);
      if (!keepBranch) await this.#deps.vcs.deleteBranch(task.repoDir, task.branch);
    });
  }

  async #launch(task: StoredTask, args: readonly string[]): Promise<void> {
    await this.#deps.sessions.launch({ repo: task.repo, cwd: task.worktree, task: task.id, args });
  }

  /** Działająca sesja pisze w worktree i trzyma jego pliki (na Windowsie blokuje usunięcie), więc najpierw stop. */
  #refuseRunning(task: StoredTask, action: string): void {
    if (this.#deps.sessions.of(task.id).some((s) => s.run.kind !== "exited"))
      throw new DomainError("bad_request", `zadanie ${task.branch} ma działającą sesję; zatrzymaj ją przed ${action}`);
  }

  /** Zakończone sesje zadania znikają z listy. */
  #closeSessions(task: StoredTask): void {
    for (const session of this.#deps.sessions.of(task.id)) this.#deps.sessions.close(session.id);
  }

  #latestSession(id: string): string | null {
    return this.#deps.sessions.of(id)[0]?.id ?? null;
  }

  async #git<T>(task: StoredTask, run: () => Promise<T>): Promise<T> {
    return run().catch((err: unknown) => {
      throw new DomainError("repo_unavailable", `${task.branch}: ${messageOf(err)}`);
    });
  }

  async #exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new DomainError("bad_request", "na tym zadaniu trwa już inna akcja");
    this.#busy.add(id);
    try {
      return await run();
    } finally {
      this.#busy.delete(id);
    }
  }

  #existingWorktree(id: string): StoredTask {
    const task = this.#get(id);
    if (!existsSync(task.worktree)) throw new DomainError("not_found", `worktree zadania ${task.branch} nie istnieje (${task.worktree})`);
    return task;
  }

  #get(id: string): StoredTask {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) throw new DomainError("not_found", `nie ma zadania ${id}`);
    return task;
  }

  #save(tasks: StoredTask[]): void {
    this.#deps.file.write(tasks);
    this.#tasks = tasks;
  }
}

function view({ repoDir: _, ...task }: StoredTask, session: string | null): Task {
  return { ...task, session };
}

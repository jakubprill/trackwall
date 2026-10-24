import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, Task, TaskChanges } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../errors.ts";
import { TASK_BRANCH_PREFIX, taskSlug, taskWorktree } from "./task-branch.ts";
import type { StoredTask, TaskFile } from "./task-file.ts";

/**
 * Zadania agentów (§4.4, ADR-31): polecenie dla Copilot CLI w osobnym worktree na nowej gałęzi od gałęzi domyślnej
 * repo, więc kilka zadań w jednym repo nie wchodzi sobie w drogę ani w katalog roboczy użytkownika. Zadanie
 * przeżywa restart daemona (`tasks.json`), a jego sesja nie; worktree i gałąź znikają tylko przy zakończeniu zadania,
 * a zmiany, które by przy tym przepadły, tylko po potwierdzeniu użytkownika.
 */

/** Diff zadania w UI: więcej i tak nikt nie przewija. */
const PATCH_MAX_BYTES = 1024 * 1024;

// Typy niżej powtarzają kształt typów z `vcs` (`WorktreeBase`, `WorktreeBranch`, `PendingWork`) zamiast je
// importować, bo moduł nie importuje sąsiedniego modułu (§4); zgodność sprawdza kompilator tam, gdzie `facade.ts` podaje `Vcs` jako `TasksVcs` (zależności `Agents`).

/** Skąd zadanie wychodzi: gałąź domyślna (`null` przy odłączonym HEAD) i commit bazowy. */
interface TaskBase {
  branch: string | null;
  commit: string;
}

/** Gałąź zadania w jej worktree, z commitem bazowym. */
interface TaskWork {
  repoDir: string;
  worktree: string;
  branch: string;
  base: string;
}

/** Co przepadłoby przy zakończeniu zadania (`PendingWork` w `vcs`). */
interface TaskPendingWork {
  uncommitted: number;
  strayCommits: number;
  branchCommits: number;
  unregisteredDir: boolean;
}

/** Czego zadania potrzebują od `vcs` (worktree i gałęzie, ADR-31); podłączane w fasadzie. */
export interface TasksVcs {
  defaultBase(dir: string): Promise<TaskBase>;
  addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void>;
  removeWorktree(repoDir: string, path: string): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;
  pendingWork(work: TaskWork): Promise<TaskPendingWork>;
  worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<TaskChanges>;
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

/** Zadanie z pliku z worktree, który z niego wynika. */
type KnownTask = StoredTask & TaskWork;

export class AgentTasks {
  readonly #deps: AgentTasksDeps;
  /** Od najnowszego. */
  #tasks: KnownTask[];
  /** Zadania, na których trwa akcja (start, wznowienie, zakończenie); druga naraz to `bad_request`. */
  readonly #busy = new Set<string>();
  /** Zadania w trakcie zakończenia: liczenie zmian odmawia, bo worktree zaraz zniknie. */
  readonly #removing = new Set<string>();
  /** Trwające liczenia zmian zadania (kilka okien naraz): zakończenie czeka, aż git przestanie czytać worktree. */
  readonly #reading = new Map<string, Set<Promise<unknown>>>();

  constructor(deps: AgentTasksDeps) {
    this.#deps = deps;
    this.#tasks = deps.file.read().map((task) => this.#known(task));
  }

  list(): Task[] {
    return this.#tasks.map(view);
  }

  /** Worktree na nowej gałęzi od gałęzi domyślnej i Copilot CLI w nim z poleceniem jako pierwszą wiadomością. */
  async create(repo: string, prompt: string): Promise<Task> {
    const repoDir = await this.#deps.repos.repoPath(repo);
    const base = await asRepoUnavailable(repo, this.#deps.vcs.defaultBase(repoDir));
    const id = randomUUID();
    const task = this.#known({
      id,
      repo,
      repoDir,
      prompt,
      branch: `${TASK_BRANCH_PREFIX}${taskSlug(prompt, id)}`,
      baseBranch: base.branch,
      base: base.commit,
      createdAt: new Date().toISOString(),
    });
    return this.#exclusive(id, async () => {
      mkdirSync(dirname(task.worktree), { recursive: true });
      await asRepoUnavailable(repo, this.#deps.vcs.addWorktree(repoDir, task.worktree, task.branch, task.base));
      // Zapis przed startem sesji: worktree już jest na dysku i nie może zniknąć z listy, gdy daemon padnie.
      this.#save([task, ...this.#tasks]);
      try {
        // `=` zamiast osobnego argumentu, żeby polecenie zaczynające się od `-` nie było opcją Copilot CLI.
        await this.#launch(task, [`--session-id=${id}`, `--interactive=${prompt}`]);
      } catch (err) {
        // Nieudane sprzątanie zostawia zadanie na liście, żeby użytkownik mógł je zakończyć sam.
        await this.#whileRemoving(id, () => this.#discard(task, false)).then(
          () => this.#save(this.#tasks.filter((t) => t.id !== id)),
          (e: unknown) => this.#deps.log(`sprzątanie zadania ${id}: ${messageOf(e)}`),
        );
        throw err;
      }
      return view(task);
    });
  }

  /** Nowa sesja zadania bez działającej sesji; Copilot CLI wznawia rozmowę zadania, bo ma ona UUID zadania. */
  resume(id: string): Promise<Task> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "wznowieniem");
      this.#closeSessions(task);
      await this.#launch(task, [`--resume=${id}`]);
      return view(task);
    });
  }

  changes(id: string): Promise<TaskChanges> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "zadanie jest właśnie kończone");
    const task = this.#existingWorktree(id);
    const reading = asRepoUnavailable(task.branch, this.#deps.vcs.worktreeChanges(task.worktree, task.base, PATCH_MAX_BYTES));
    const reads = this.#reading.get(id) ?? new Set();
    this.#reading.set(id, reads.add(reading));
    void reading
      .catch(() => {})
      .finally(() => {
        reads.delete(reading);
        if (reads.size === 0) this.#reading.delete(id);
      });
    return reading;
  }

  openEditor(id: string): void {
    this.#deps.openEditor(this.#existingWorktree(id).worktree);
  }

  /**
   * Zakończenie zadania: usuwa worktree, a bez `keepBranch` także gałąź. Niezacommitowane pliki i commity spoza
   * gałęzi, a przy usuwaniu gałęzi także commity zadania, przepadają tylko z `discardChanges`; inaczej
   * `unsaved_changes` z tym, co by przepadło.
   */
  remove(id: string, keepBranch: boolean, discardChanges: boolean): Promise<void> {
    const task = this.#get(id);
    return this.#exclusive(id, async () => {
      this.#refuseRunning(task, "zakończeniem");
      await this.#whileRemoving(id, async () => {
        if (!discardChanges) await this.#refuseLoss(task, keepBranch);
        await this.#discard(task, keepBranch);
      });
      this.#closeSessions(task);
      this.#save(this.#tasks.filter((t) => t.id !== id));
    });
  }

  /** `job` kasujący worktree dopiero, gdy git przestał go czytać; nowe liczenie zmian w tym czasie odmawia. */
  async #whileRemoving(id: string, job: () => Promise<void>): Promise<void> {
    this.#removing.add(id);
    try {
      await Promise.allSettled(this.#reading.get(id) ?? []);
      await job();
    } finally {
      this.#removing.delete(id);
    }
  }

  async #refuseLoss(task: KnownTask, keepBranch: boolean): Promise<void> {
    const pending = await asRepoUnavailable(task.branch, this.#deps.vcs.pendingWork(task));
    const lost = [
      pending.unregisteredDir &&
        `katalog ${task.worktree} z całą zawartością, bo git go nie zna jako worktree (przerwane usuwanie albo repo przeniesione lub usunięte)`,
      pending.uncommitted > 0 && `niezacommitowane zmiany w worktree (${pending.uncommitted})`,
      pending.strayCommits > 0 && `commity poza gałęzią, z odłączonego HEAD (${pending.strayCommits})`,
      !keepBranch && pending.branchCommits > 0 && `commity na gałęzi ${task.branch} (${pending.branchCommits})`,
    ].filter((s) => s !== false);
    if (lost.length > 0) throw new DomainError("unsaved_changes", `zakończenie skasowałoby: ${lost.join(", ")}`);
  }

  /** Worktree (z niezacommitowanymi i ignorowanymi plikami) i, bez `keepBranch`, gałąź. */
  async #discard(task: KnownTask, keepBranch: boolean): Promise<void> {
    await asRepoUnavailable(task.branch, this.#deps.vcs.removeWorktree(task.repoDir, task.worktree));
    if (!keepBranch) await asRepoUnavailable(task.branch, this.#deps.vcs.deleteBranch(task.repoDir, task.branch));
  }

  async #launch(task: KnownTask, args: readonly string[]): Promise<void> {
    await this.#deps.sessions.launch({ repo: task.repo, cwd: task.worktree, task: task.id, args });
  }

  /** Działająca sesja pisze w worktree i trzyma jego pliki (na Windowsie blokuje usunięcie), więc najpierw stop. */
  #refuseRunning(task: KnownTask, action: string): void {
    if (this.#deps.sessions.of(task.id).some((s) => s.run.kind !== "exited"))
      throw new DomainError("bad_request", `zadanie ${task.branch} ma działającą sesję; zatrzymaj ją przed ${action}`);
  }

  /** Zakończone sesje zadania znikają z listy. */
  #closeSessions(task: KnownTask): void {
    for (const session of this.#deps.sessions.of(task.id)) this.#deps.sessions.close(session.id);
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

  #existingWorktree(id: string): KnownTask {
    const task = this.#get(id);
    if (!existsSync(task.worktree)) throw new DomainError("not_found", `worktree zadania ${task.branch} nie istnieje (${task.worktree})`);
    return task;
  }

  #get(id: string): KnownTask {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) throw new DomainError("not_found", `nie ma zadania ${id}`);
    return task;
  }

  #known(task: StoredTask): KnownTask {
    return { ...task, worktree: taskWorktree(this.#deps.worktreesDir, task.repo, task.branch) };
  }

  #save(tasks: KnownTask[]): void {
    this.#deps.file.write(tasks.map(({ worktree: _, ...stored }) => stored));
    this.#tasks = tasks;
  }
}

function view({ repoDir: _, ...task }: KnownTask): Task {
  return task;
}

/** Błąd gita w repo albo worktree zadania jako `repo_unavailable` z komunikatem gita. */
function asRepoUnavailable<T>(label: string, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${label}: ${messageOf(err)}`);
  });
}

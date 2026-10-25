import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  PATCH_MAX_BYTES,
  type ProposedBy,
  type Session,
  TASK_SUMMARY_MAX_FILES,
  type Task,
  type TaskChanges,
  type TaskChangesSummary,
  type TaskMiseConfig,
  type TaskSharedFiles,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { TASK_BRANCH_PREFIX, taskSlug, taskWorktree } from "./task-branch.ts";
import type { StoredTask, TaskFile } from "./task-file.ts";
import { type MiseSnapshot, miseConfigChanges, miseConfigDigest, readMiseConfig, reviewMiseConfig } from "./task-mise-config.ts";

/**
 * Zadania agentów (§4.4, ADR-31): polecenie dla Copilot CLI w osobnym worktree na nowej gałęzi od gałęzi domyślnej
 * repo, więc kilka zadań w jednym repo nie wchodzi sobie w drogę ani w katalog roboczy użytkownika. Zadanie
 * przeżywa restart daemona (`tasks.json`), a jego sesja nie; worktree i gałąź znikają tylko przy zakończeniu zadania,
 * a zmiany, które by przy tym przepadły, tylko po potwierdzeniu użytkownika.
 */

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
  /** Copilot CLI w worktree zadania z argumentami zadania (polecenie, wtedy `promptOnStart`, albo wznowienie). */
  launch(spec: { repo: string; cwd: string; task: string; args: readonly string[]; promptOnStart: boolean }): Promise<Session>;
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
  /** Some process group still works in this directory (`procs.liveIn`): a mise task in the worktree locks its files on Windows. */
  liveIn: (dir: string) => boolean;
  /** Katalog worktree zadań w katalogu stanu; poza folderem z projektami, więc lista repo ich nie widzi. */
  worktreesDir: string;
  openEditor: (dir: string) => void;
  log: (msg: string) => void;
}

/** Skąd zadanie: z formularza (bez tytułu i zgłaszającego) albo z zatwierdzonej propozycji (ADR-39), której bierze identyfikator. */
export interface TaskOrigin {
  id: string;
  title: string | null;
  proposedBy: ProposedBy | null;
}

/** Zadanie z pliku z worktree, który z niego wynika. */
type KnownTask = StoredTask & TaskWork;

/**
 * Other tasks read at once for shared files: each read is several git commands, and a task panel asks every few
 * seconds, so a repo with many tasks must not start dozens of git processes at a time (slow on Windows).
 */
const SHARED_FILES_CONCURRENCY = 3;

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

  /**
   * Worktree na nowej gałęzi od gałęzi domyślnej i Copilot CLI w nim z poleceniem jako pierwszą wiadomością; gałąź
   * nazywa tytuł, a bez niego polecenie.
   */
  async create(repo: string, prompt: string, { id, title, proposedBy }: TaskOrigin): Promise<Task> {
    const repoDir = await this.#deps.repos.repoPath(repo);
    const base = await asRepoUnavailable(repo, this.#deps.vcs.defaultBase(repoDir));
    const task = this.#known({
      id,
      repo,
      repoDir,
      prompt,
      branch: `${TASK_BRANCH_PREFIX}${taskSlug(title ?? prompt, id)}`,
      baseBranch: base.branch,
      base: base.commit,
      createdAt: new Date().toISOString(),
      title,
      proposedBy,
      summary: null,
      trustedMiseConfig: null,
    });
    return this.#exclusive(id, async () => {
      mkdirSync(dirname(task.worktree), { recursive: true });
      await asRepoUnavailable(repo, this.#deps.vcs.addWorktree(repoDir, task.worktree, task.branch, task.base));
      // The mise config of the fresh worktree is the base commit's, from the repo whose config the user trusted (ADR-59).
      task.trustedMiseConfig = await this.#initialMiseConfig(task);
      // Zapis przed startem sesji: worktree już jest na dysku i nie może zniknąć z listy, gdy daemon padnie.
      this.#save([task, ...this.#tasks]);
      try {
        // `=` zamiast osobnego argumentu, żeby polecenie zaczynające się od `-` nie było opcją Copilot CLI.
        await this.#launch(task, [`--session-id=${id}`, `--interactive=${prompt}`], true);
      } catch (err) {
        // Nieudane sprzątanie zostawia zadanie na liście, żeby użytkownik mógł je zakończyć sam.
        await this.#whileRemoving(id, () => this.#discard(task, false)).then(
          () => this.#save(this.#tasks.filter((t) => t.id !== id)),
          (e: unknown) => this.#deps.log(`cleaning up task ${id}: ${messageOf(e)}`),
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
      this.#refuseRunning(task, "resuming");
      this.#closeSessions(task);
      await this.#launch(task, [`--resume=${id}`], false);
      return view(task);
    });
  }

  /** Zadanie po identyfikatorze (`not_found`, gdy go nie ma). */
  task(id: string): Task {
    return view(this.#get(id));
  }

  /** Zadanie po identyfikatorze albo `undefined`, gdy go nie ma (czekanie na propozycję, która jeszcze nie jest zadaniem). */
  find(id: string): Task | undefined {
    const task = this.#tasks.find((t) => t.id === id);
    return task && view(task);
  }

  /** Trwa akcja na zadaniu (start, wznowienie, zakończenie), np. sesja nowego zadania jeszcze się uruchamia. */
  busy(id: string): boolean {
    return this.#busy.has(id);
  }

  /** Podsumowanie od sesji zadania (`report_result`, ADR-39); kolejne zastępuje poprzednie i przeżywa restart daemona. */
  setSummary(id: string, text: string): Task {
    const summarized = { ...this.#get(id), summary: { text, reportedAt: new Date().toISOString() } };
    this.#save(this.#tasks.map((t) => (t.id === id ? summarized : t)));
    return view(summarized);
  }

  changes(id: string): Promise<TaskChanges> {
    return this.#readChanges(id, PATCH_MAX_BYTES);
  }

  /**
   * Zmiany bez diffu, z najwyżej `TASK_SUMMARY_MAX_FILES` plikami, dla kontekstu agenta (narzędzie MCP `get_session`);
   * agent, który chce treści, czyta worktree sam.
   */
  async summary(id: string): Promise<TaskChangesSummary> {
    const { files, commits, uncommitted } = await this.#readChanges(id, 0);
    return { files: files.slice(0, TASK_SUMMARY_MAX_FILES), filesTruncated: files.length > TASK_SUMMARY_MAX_FILES, commits, uncommitted };
  }

  /**
   * Shared files (ADR-44): files changed both in this task and in another task of the same repo. Changes of another task
   * that cannot be read (being ended, worktree deleted by hand, broken index) are left out, because this is only a
   * warning; a failure to read this task's own changes is reported as in `changes`. A cut-off file list (`truncated`)
   * can miss a shared file, which is acceptable for a warning.
   */
  async sharedFiles(id: string): Promise<TaskSharedFiles[]> {
    const own = this.#get(id);
    const changed = new Set((await this.#readChanges(id, 0)).files.map((f) => f.path));
    const others = this.#tasks.filter((t) => t.repo === own.repo && t.id !== id);
    const theirs = await mapLimit(others, SHARED_FILES_CONCURRENCY, async (other) => ({
      task: other.id,
      files: (await this.#tryChangedPaths(other.id)).filter((path) => changed.has(path)),
    }));
    return theirs.filter((t) => t.files.length > 0);
  }

  /** Paths changed in a task, or none when its changes cannot be read for a known reason (`DomainError`). */
  async #tryChangedPaths(id: string): Promise<string[]> {
    try {
      return (await this.#readChanges(id, 0)).files.map((f) => f.path);
    } catch (err) {
      if (err instanceof DomainError) return [];
      throw err;
    }
  }

  #readChanges(id: string, maxPatchBytes: number): Promise<TaskChanges> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is already being ended");
    const task = this.#existingWorktree(id);
    const reading = asRepoUnavailable(task.branch, this.#deps.vcs.worktreeChanges(task.worktree, task.base, maxPatchBytes));
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

  /** The worktree's mise config against the trusted one (ADR-59), with the text of each changed file for the user to read. */
  miseConfig(id: string): Promise<TaskMiseConfig> {
    const task = this.#existingWorktree(id);
    return reviewMiseConfig(task.worktree, task.trustedMiseConfig);
  }

  /**
   * The user trusts the worktree's current mise config (ADR-59). `digest` is the one they saw: a config the agent
   * changed again in the meantime is refused, so the trust never covers a version nobody looked at.
   */
  async trustMiseConfig(id: string, digest: string): Promise<TaskMiseConfig> {
    const task = this.#existingWorktree(id);
    const current = await readMiseConfig(task.worktree);
    if (miseConfigDigest(current) !== digest)
      throw new DomainError("bad_request", `the mise config of task ${task.branch} changed again; review it before trusting it`);
    const trusted = { ...this.#get(id), trustedMiseConfig: current };
    this.#save(this.#tasks.map((t) => (t.id === id ? trusted : t)));
    return { neverTrusted: false, changes: [], digest };
  }

  /**
   * The worktree of a task of `repo` for running a mise task in it (ADR-59), only while it has the mise config the user
   * trusted and the task is not being ended: `mise_unavailable` names the changed files, and only the user can trust
   * them, in the task's panel.
   */
  async trustedWorktree(id: string, repo: string): Promise<string> {
    if (this.#removing.has(id)) throw new DomainError("bad_request", "this task is being ended");
    const task = this.#existingWorktree(id);
    if (task.repo !== repo) throw new DomainError("bad_request", `task ${task.branch} is in ${task.repo}, not in ${repo}`);
    const changes = miseConfigChanges(task.trustedMiseConfig ?? {}, await readMiseConfig(task.worktree));
    if (changes.length > 0)
      throw new DomainError(
        "mise_unavailable",
        `the mise config in the worktree of task ${task.branch} changed since the user trusted it (${changes.map((c) => c.path).join(", ")}); ` +
          "only the user can trust it, in the task's panel in Trackwall",
      );
    return task.worktree;
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
      this.#refuseRunning(task, "ending it");
      if (this.#deps.liveIn(task.worktree))
        throw new DomainError(
          "bad_request",
          `a process started by Trackwall still runs in the worktree of task ${task.branch}; stop it before ending the task`,
        );
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
        `directory ${task.worktree} with all its contents, because git does not know it as a worktree (interrupted removal, or the repo was moved or deleted)`,
      pending.uncommitted > 0 && `uncommitted changes in the worktree (${pending.uncommitted})`,
      pending.strayCommits > 0 && `commits outside the branch, from a detached HEAD (${pending.strayCommits})`,
      !keepBranch && pending.branchCommits > 0 && `commits on branch ${task.branch} (${pending.branchCommits})`,
    ].filter((s) => s !== false);
    if (lost.length > 0) throw new DomainError("unsaved_changes", `ending the task would delete: ${lost.join(", ")}`);
  }

  /** Worktree (z niezacommitowanymi i ignorowanymi plikami) i, bez `keepBranch`, gałąź. */
  async #discard(task: KnownTask, keepBranch: boolean): Promise<void> {
    await asRepoUnavailable(task.branch, this.#deps.vcs.removeWorktree(task.repoDir, task.worktree));
    if (!keepBranch) await asRepoUnavailable(task.branch, this.#deps.vcs.deleteBranch(task.repoDir, task.branch));
  }

  /** A worktree whose mise config cannot be read gets no trust: the user can trust it in the task panel. */
  async #initialMiseConfig(task: KnownTask): Promise<MiseSnapshot | null> {
    try {
      return await readMiseConfig(task.worktree);
    } catch (err) {
      this.#deps.log(`reading the mise config of task ${task.id}: ${messageOf(err)}`);
      return null;
    }
  }

  async #launch(task: KnownTask, args: readonly string[], promptOnStart: boolean): Promise<void> {
    await this.#deps.sessions.launch({ repo: task.repo, cwd: task.worktree, task: task.id, args, promptOnStart });
  }

  /** Działająca sesja pisze w worktree i trzyma jego pliki (na Windowsie blokuje usunięcie), więc najpierw stop. */
  #refuseRunning(task: KnownTask, action: string): void {
    if (this.#deps.sessions.of(task.id).some((s) => s.run.kind !== "exited"))
      throw new DomainError("bad_request", `task ${task.branch} has a running session; stop it before ${action}`);
  }

  /** Zakończone sesje zadania znikają z listy. */
  #closeSessions(task: KnownTask): void {
    for (const session of this.#deps.sessions.of(task.id)) this.#deps.sessions.close(session.id);
  }

  async #exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new DomainError("bad_request", "another action is already running on this task");
    this.#busy.add(id);
    try {
      return await run();
    } finally {
      this.#busy.delete(id);
    }
  }

  #existingWorktree(id: string): KnownTask {
    const task = this.#get(id);
    if (!existsSync(task.worktree))
      throw new DomainError("not_found", `the worktree of task ${task.branch} does not exist (${task.worktree})`);
    return task;
  }

  #get(id: string): KnownTask {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) throw new DomainError("not_found", `no task ${id}`);
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

function view({ repoDir: _, trustedMiseConfig: __, ...task }: KnownTask): Task {
  return task;
}

/** Błąd gita w repo albo worktree zadania jako `repo_unavailable` z komunikatem gita. */
function asRepoUnavailable<T>(label: string, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${label}: ${messageOf(err)}`);
  });
}

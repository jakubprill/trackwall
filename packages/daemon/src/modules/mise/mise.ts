import { delimiter } from "node:path";
import {
  type LogSource,
  type MiseTask,
  MiseTaskName,
  type MiseTasks,
  miseTaskLogSource,
  type RunningMiseTask,
  type RunState,
} from "@trackwall/protocol";
import { z } from "zod";
import { envKey } from "../../infra/env-key.ts";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { type MiseCliResult, runMiseCli } from "./mise-cli.ts";

/**
 * Moduł `mise` (§4, ADR-20): taski mise repo z workspace i ich uruchomienia. Lista pochodzi z `mise tasks ls --json`
 * przy każdym zapytaniu, więc zmiana `mise.toml` widać od razu. Uruchomienie to `mise run <task>` w korzeniu repo,
 * w grupie procesów modułu `procs`; daemon uruchamia tylko task, który jest na aktualnej liście (§1.2). Dla komendy
 * zbiorczej (ADR-27) także `mise install` i uruchomienia doczekane do końca. A task's mise tasks run in its worktree
 * (ADR-59) only while the repo root's config is trusted and the worktree has the mise config the user trusted; mise
 * gets the worktree as a trusted path for that one run, never through `mise trust`, which would trust the path for good.
 */

/** Czego `mise` potrzebuje od `procs`; podłączane w fasadzie. */
interface MiseProcs {
  start(spec: { owner: string; command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; logSource: LogSource }): Promise<RunState>;
  state(owner: string): RunState | undefined;
  ended(owner: string): Promise<RunState | undefined>;
  stop(owner: string): Promise<RunState | undefined>;
}

/** Czego `mise` potrzebuje od `workspace`: korzeń repo po identyfikatorze (`not_found`, gdy repo nie ma). */
interface MiseRepos {
  repoPath(id: string): Promise<string>;
}

/** What `mise` needs from `agents`: a task's worktree and how its mise config differs from the trusted one (ADR-59). */
interface MiseTaskCheckouts {
  taskCheckout(task: string): Promise<{ repo: string; worktree: string; miseConfigChanges: readonly { path: string }[] }>;
}

export interface MiseDeps {
  procs: MiseProcs;
  repos: MiseRepos;
  tasks: MiseTaskCheckouts;
  /** Program `mise` z ewentualnymi argumentami przed komendą; w daemonie `["mise"]`, w testach atrapa. */
  command: readonly string[];
  /** Środowisko procesów użytkownika (`PATH` z powłoki logowania na macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
}

/** Pola `mise tasks ls --json`, których używamy; reszta (zależności, źródła, `run`) zostaje w mise. */
const ListedTask = z.object({ name: z.string(), description: z.string().nullish(), hide: z.boolean().optional() });
const ListedTasks = z.array(ListedTask);

/** Task z `mise tasks ls`, jeszcze bez stanu uruchomienia. */
type ListedMiseTask = Omit<MiseTask, "run">;
type TaskList = { kind: Exclude<MiseTasks["kind"], "ok">; message: string } | { kind: "ok"; tasks: ListedMiseTask[] };

/** Fragment komunikatu mise o konfiguracji bez zaufania (`Config files in … are not trusted`). */
const UNTRUSTED = /not trusted/i;
/** mise setting with directories whose configs it trusts, separated like `PATH` (`list_by_os_path_separator`). */
const TRUSTED_PATHS_ENV = "MISE_TRUSTED_CONFIG_PATHS";

/** Where a mise task runs: the repo root (`task: null`) or the worktree of a task of that repo (ADR-59). */
export interface MiseTarget {
  repo: string;
  task: string | null;
}

/** The directory and environment of a run. */
interface RunPlace {
  dir: string;
  env: NodeJS.ProcessEnv;
}

export class Mise {
  private readonly deps: MiseDeps;
  /**
   * mise tasks started in this daemon run, per target (`targetKey`): the list shows them even after they left the
   * config, and `running` reports them without asking mise.
   */
  private readonly started = new Map<string, MiseTarget & { names: Set<string> }>();

  constructor(deps: MiseDeps) {
    this.deps = deps;
  }

  /** The mise tasks of a repo root with their runs there. */
  async tasks(repo: string): Promise<MiseTasks> {
    const root: MiseTarget = { repo, task: null };
    const dir = await this.deps.repos.repoPath(repo);
    const listed = await this.list(dir, await this.deps.env());
    if (listed.kind !== "ok") return { ...listed, running: this.liveOutside(root, []) };
    const tasks: MiseTask[] = listed.tasks.map((t) => ({ ...t, run: this.deps.procs.state(owner(root, t.name)) ?? null }));
    return { kind: "ok", tasks: [...tasks, ...this.liveOutside(root, tasks)] };
  }

  /** Running mise tasks of all repo roots and task worktrees started in this daemon run; state from `procs`, without asking mise. */
  running(): RunningMiseTask[] {
    return [...this.started.values()].flatMap((target) =>
      this.liveRuns(target).map(({ name, run }) => ({ repo: target.repo, task: target.task, miseTask: name, run })),
    );
  }

  /**
   * Działające taski repo spoza listy: usunięte z konfiguracji w trakcie działania albo pokazane, gdy mise listy
   * nie podał. Bez nich nie dałoby się ich zatrzymać z UI.
   */
  private liveOutside(target: MiseTarget, listed: readonly ListedMiseTask[]): MiseTask[] {
    return this.liveRuns(target)
      .filter(({ name }) => !listed.some((t) => t.name === name))
      .map(({ name, run }) => ({ name, description: "", run }));
  }

  /** Taski uruchomione przez daemon w `target`, których grupa jeszcze nie skończyła (także w trakcie zatrzymywania). */
  private liveRuns(target: MiseTarget): { name: string; run: RunState }[] {
    return [...(this.started.get(targetKey(target))?.names ?? [])].flatMap((name) => {
      const run = this.deps.procs.state(owner(target, name));
      return run && run.kind !== "exited" ? [{ name, run }] : [];
    });
  }

  async start(target: MiseTarget, miseTask: string): Promise<RunState> {
    const place = await this.place(target);
    if (!(await this.hasTask(place, miseTask))) throw new DomainError("not_found", `${where(target)} has no mise task "${miseTask}"`);
    const run = await this.launch(
      owner(target, miseTask),
      place,
      ["run", miseTask],
      target.repo,
      miseTaskLogSource(target.repo, target.task, miseTask),
    );
    this.remember(target, miseTask);
    return run;
  }

  /**
   * Komenda zbiorcza (§4.8): task z aktualnej listy uruchomiony i doczekany do potwierdzonego końca grupy; `null`,
   * gdy repo nie ma takiego taska. Działający już task (np. ze szczegółów repo) nie startuje drugi raz: wynikiem jest jego
   * koniec. `signal` zatrzymuje grupę tak jak stop ze szczegółów repo.
   */
  async runToEnd(repo: string, miseTask: string, signal: AbortSignal): Promise<RunState | null> {
    const root: MiseTarget = { repo, task: null };
    const place = await this.place(root);
    if (!(await this.hasTask(place, miseTask))) return null;
    this.remember(root, miseTask);
    return this.runGroupToEnd(owner(root, miseTask), place, ["run", miseTask], repo, miseTaskLogSource(repo, null, miseTask), signal);
  }

  /**
   * `mise install` w korzeniu repo, doczekany do końca: narzędzia (JDK, Node…) w wersjach z konfiguracji mise repo.
   * W grupie procesów jak task, bo instalacja trwa minutami, a przerwanie komendy zbiorczej ma ją zatrzymać.
   */
  async installTools(repo: string, signal: AbortSignal): Promise<RunState> {
    const place = await this.place({ repo, task: null });
    return this.runGroupToEnd(installOwner(repo), place, ["install"], repo, { kind: "mise-install", repo }, signal);
  }

  /**
   * The task's current run once the system has confirmed its end, or after `timeoutMs` (then still `running` or
   * `stopping`), for an agent waiting for the result (`wait_for_mise_task`, ADR-41). `signal` (the client cancelled
   * the call) ends the wait but does not stop the task.
   */
  async waitForEnd(target: MiseTarget, miseTask: string, timeoutMs: number, signal: AbortSignal): Promise<RunState> {
    const groupOwner = owner(target, miseTask);
    // `ended` first waits for a start in progress (e.g. the Run button clicked at the same moment), so the wait sees
    // the new run instead of the previous one or none; an ended group resolves at once, an absent one as `undefined`.
    const giveUp = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let stopWaiting = () => {};
    const gaveUp = new Promise<"gave_up">((resolve) => {
      stopWaiting = () => resolve("gave_up");
    });
    giveUp.addEventListener("abort", stopWaiting, { once: true });
    if (giveUp.aborted) stopWaiting();
    try {
      const end = await Promise.race([this.deps.procs.ended(groupOwner), gaveUp]);
      const run = end === "gave_up" ? this.deps.procs.state(groupOwner) : end;
      if (!run) throw await this.notRun(target, miseTask);
      return run;
    } finally {
      giveUp.removeEventListener("abort", stopWaiting);
    }
  }

  /** The current (or last) run of a task in this daemon run, from `procs` without asking mise; `undefined` when it has not run. */
  run(target: MiseTarget, miseTask: string): RunState | undefined {
    return this.deps.procs.state(owner(target, miseTask));
  }

  async stop(target: MiseTarget, miseTask: string): Promise<RunState> {
    const stopped = await this.deps.procs.stop(owner(target, miseTask));
    if (!stopped) throw await this.notRun(target, miseTask);
    return stopped;
  }

  /**
   * `not_found` for a task without a run: about the repo when it is not in the projects folder (a typo in the id),
   * otherwise about the task. Checked only after the run lookup, so a task of a repo that was renamed or removed
   * while it ran can still be stopped and waited for.
   */
  private async notRun(target: MiseTarget, miseTask: string): Promise<DomainError> {
    await this.deps.repos.repoPath(target.repo);
    const place = target.task === null ? target.repo : where(target);
    return new DomainError("not_found", `mise task "${miseTask}" in ${place} has not been run`);
  }

  /** `mise trust` bez ścieżki ufa konfiguracji w korzeniu repo, nie w katalogach nadrzędnych. */
  async trust(repo: string): Promise<MiseTasks> {
    // The repo root only: a task worktree is trusted by its mise config instead (ADR-59, `agents`).
    const dir = await this.deps.repos.repoPath(repo);
    const result = await runMiseCli(this.deps.command, ["trust"], dir, await this.deps.env());
    if (result.kind !== "exited") throw new DomainError("mise_unavailable", result.message);
    if (result.code !== 0) throw new DomainError("mise_unavailable", failure(result.stderr, result.code));
    return this.tasks(repo);
  }

  /**
   * Where a run of `target` happens. A task worktree (ADR-59) needs the repo root's config trusted, since the
   * worktree's config came from it, and the worktree's mise config unchanged since the user trusted it; then mise gets
   * the worktree as a trusted path in this run's environment only.
   */
  private async place(target: MiseTarget): Promise<RunPlace> {
    const root = await this.deps.repos.repoPath(target.repo);
    const env = await this.deps.env();
    if (target.task === null) return { dir: root, env };
    const checkout = await this.deps.tasks.taskCheckout(target.task);
    if (checkout.repo !== target.repo)
      throw new DomainError("bad_request", `task ${target.task} is in ${checkout.repo}, not in ${target.repo}`);
    const listed = await this.list(root, env);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", `${target.repo}: ${listed.message}`);
    if (checkout.miseConfigChanges.length > 0) {
      const files = checkout.miseConfigChanges.map((c) => c.path).join(", ");
      throw new DomainError(
        "mise_unavailable",
        `the mise config in the worktree of task ${target.task} changed since the user trusted it (${files}); ` +
          "only the user can trust it, in the task's panel in Trackwall",
      );
    }
    return { dir: checkout.worktree, env: trustingPath(env, checkout.worktree) };
  }

  private async hasTask(place: RunPlace, miseTask: string): Promise<boolean> {
    const listed = await this.list(place.dir, place.env);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", listed.message);
    return listed.tasks.some((t) => t.name === miseTask);
  }

  /** Task uruchomiony w tym działaniu daemona: lista pokaże go do zatrzymania, nawet gdy zniknie z konfiguracji. */
  private remember(target: MiseTarget, miseTask: string): void {
    const key = targetKey(target);
    const started = this.started.get(key) ?? { ...target, names: new Set<string>() };
    started.names.add(miseTask);
    this.started.set(key, started);
  }

  private async launch(
    groupOwner: string,
    place: RunPlace,
    args: readonly string[],
    repo: string,
    logSource: LogSource,
  ): Promise<RunState> {
    try {
      return await this.deps.procs.start({
        owner: groupOwner,
        command: [...this.deps.command, ...args],
        cwd: place.dir,
        env: place.env,
        logSource,
      });
    } catch (err) {
      if (!(err instanceof SpawnFailure)) throw err;
      throw new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "mise_unavailable", `${repo}: ${err.message}`);
    }
  }

  /**
   * Start (albo dołączenie do działającej grupy tego właściciela) i koniec grupy po potwierdzeniu w systemie.
   * `signal` zatrzymuje grupę; gdy grupa przeżyje zabicie, wynikiem jest `stop_unconfirmed`, a nie czekanie bez
   * końca, więc przerwanie zawsze kończy czekanie. Grupa zostaje wtedy `stopping` w szczegółach repo, skąd stop można ponowić.
   */
  private async runGroupToEnd(
    groupOwner: string,
    place: RunPlace,
    args: readonly string[],
    repo: string,
    logSource: LogSource,
    signal: AbortSignal,
  ): Promise<RunState> {
    signal.throwIfAborted();
    await this.launch(groupOwner, place, args, repo, logSource);
    let stop = () => {};
    const stopFailed = new Promise<never>((_, reject) => {
      stop = () => void this.deps.procs.stop(groupOwner).catch(reject);
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const end = await Promise.race([this.deps.procs.ended(groupOwner), stopFailed]);
      if (!end) throw new Error(`group ${groupOwner} disappeared before it ended`);
      return end;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  private async list(dir: string, env: NodeJS.ProcessEnv): Promise<TaskList> {
    return parseTaskList(await runMiseCli(this.deps.command, ["tasks", "ls", "--json"], dir, env));
  }
}

/** Wynik `mise tasks ls --json` jako lista tasków albo powód, dla którego jej nie ma. */
export function parseTaskList(result: MiseCliResult): TaskList {
  if (result.kind === "not_started") return { kind: "not_installed", message: result.message };
  if (result.kind === "failed") return { kind: "error", message: result.message };
  if (result.code !== 0) {
    const message = failure(result.stderr, result.code);
    return UNTRUSTED.test(message) ? { kind: "untrusted", message } : { kind: "error", message };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { kind: "error", message: "mise tasks ls --json returned something that is not JSON" };
  }
  const parsed = ListedTasks.safeParse(json);
  if (!parsed.success) return { kind: "error", message: `unexpected mise tasks ls --json format: ${z.prettifyError(parsed.error)}` };
  const tasks = parsed.data
    .filter((t) => !t.hide && MiseTaskName.safeParse(t.name).success)
    .map((t) => ({ name: t.name, description: t.description ?? "" }));
  return { kind: "ok", tasks };
}

/**
 * Klucz właściciela grupy w `procs`; tylko budowany, nigdy rozbierany z powrotem. A task's prefix differs from a
 * repo's, so no repo id and mise task name (which may contain `:`) can give the key of a task's run.
 */
function owner(target: MiseTarget, miseTask: string): string {
  return target.task === null ? `mise:${target.repo}:${miseTask}` : `task-mise:${target.task}:${miseTask}`;
}

function targetKey(target: MiseTarget): string {
  return target.task === null ? `repo:${target.repo}` : `task:${target.task}`;
}

/** The target in a message: the repo, or the task worktree in it. */
function where({ repo, task }: MiseTarget): string {
  return task === null ? `repo ${repo}` : `the worktree of task ${task} in ${repo}`;
}

/** The environment with `dir` added to the paths mise trusts without `mise trust`, after the user's own. */
function trustingPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = envKey(env, TRUSTED_PATHS_ENV);
  const own = env[key];
  return { ...env, [key]: own ? `${own}${delimiter}${dir}` : dir };
}

/** Właściciel grupy `mise install` repo; inny przedrostek niż taski, bo task może nazywać się `install`. */
function installOwner(repo: string): string {
  return `mise-install:${repo}`;
}

/** Komunikat błędu mise bez ostrzeżeń, które nie są przyczyną (np. nieudane sprawdzenie nowej wersji). */
function failure(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^mise WARN/.test(l));
  return lines.join("\n") || `mise exited with code ${code}`;
}

import { type LogSource, type MiseTask, MiseTaskName, type MiseTasks, type RunningMiseTask, type RunState } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { type MiseCliResult, runMiseCli } from "./mise-cli.ts";

/**
 * Moduł `mise` (§4, ADR-20): taski mise repo z workspace i ich uruchomienia. Lista pochodzi z `mise tasks ls --json`
 * przy każdym zapytaniu, więc zmiana `mise.toml` widać od razu. Uruchomienie to `mise run <task>` w korzeniu repo,
 * w grupie procesów modułu `procs`; daemon uruchamia tylko task, który jest na aktualnej liście (§1.2). Dla komendy
 * zbiorczej (ADR-27) także `mise install` i uruchomienia doczekane do końca.
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

export interface MiseDeps {
  procs: MiseProcs;
  repos: MiseRepos;
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

export class Mise {
  private readonly deps: MiseDeps;
  /** Taski uruchomione w tym działaniu daemona, per repo: lista pokazuje je także po usunięciu z konfiguracji. */
  private readonly started = new Map<string, Set<string>>();

  constructor(deps: MiseDeps) {
    this.deps = deps;
  }

  async tasks(repo: string): Promise<MiseTasks> {
    const listed = await this.list(await this.deps.repos.repoPath(repo));
    if (listed.kind !== "ok") return { ...listed, running: this.liveOutside(repo, []) };
    const tasks: MiseTask[] = listed.tasks.map((t) => ({ ...t, run: this.deps.procs.state(owner(repo, t.name)) ?? null }));
    return { kind: "ok", tasks: [...tasks, ...this.liveOutside(repo, tasks)] };
  }

  /** Działające taski wszystkich repo uruchomione w tym działaniu daemona; stan z `procs`, bez pytania mise. */
  running(): RunningMiseTask[] {
    return [...this.started.keys()].flatMap((repo) => this.liveRuns(repo).map(({ name, run }) => ({ repo, miseTask: name, run })));
  }

  /**
   * Działające taski repo spoza listy: usunięte z konfiguracji w trakcie działania albo pokazane, gdy mise listy
   * nie podał. Bez nich nie dałoby się ich zatrzymać z UI.
   */
  private liveOutside(repo: string, listed: readonly ListedMiseTask[]): MiseTask[] {
    return this.liveRuns(repo)
      .filter(({ name }) => !listed.some((t) => t.name === name))
      .map(({ name, run }) => ({ name, description: "", run }));
  }

  /** Taski repo uruchomione przez daemon, których grupa jeszcze nie skończyła (także w trakcie zatrzymywania). */
  private liveRuns(repo: string): { name: string; run: RunState }[] {
    return [...(this.started.get(repo) ?? [])].flatMap((name) => {
      const run = this.deps.procs.state(owner(repo, name));
      return run && run.kind !== "exited" ? [{ name, run }] : [];
    });
  }

  async start(repo: string, miseTask: string): Promise<RunState> {
    const dir = await this.deps.repos.repoPath(repo);
    if (!(await this.hasTask(dir, miseTask))) throw new DomainError("not_found", `repo ${repo} has no mise task "${miseTask}"`);
    const run = await this.launch(owner(repo, miseTask), dir, ["run", miseTask], repo, taskLogSource(repo, miseTask));
    this.remember(repo, miseTask);
    return run;
  }

  /**
   * Komenda zbiorcza (§4.8): task z aktualnej listy uruchomiony i doczekany do potwierdzonego końca grupy; `null`,
   * gdy repo nie ma takiego taska. Działający już task (np. ze szczegółów repo) nie startuje drugi raz: wynikiem jest jego
   * koniec. `signal` zatrzymuje grupę tak jak stop ze szczegółów repo.
   */
  async runToEnd(repo: string, miseTask: string, signal: AbortSignal): Promise<RunState | null> {
    const dir = await this.deps.repos.repoPath(repo);
    if (!(await this.hasTask(dir, miseTask))) return null;
    this.remember(repo, miseTask);
    return this.runGroupToEnd(owner(repo, miseTask), dir, ["run", miseTask], repo, taskLogSource(repo, miseTask), signal);
  }

  /**
   * `mise install` w korzeniu repo, doczekany do końca: narzędzia (JDK, Node…) w wersjach z konfiguracji mise repo.
   * W grupie procesów jak task, bo instalacja trwa minutami, a przerwanie komendy zbiorczej ma ją zatrzymać.
   */
  async installTools(repo: string, signal: AbortSignal): Promise<RunState> {
    const dir = await this.deps.repos.repoPath(repo);
    return this.runGroupToEnd(installOwner(repo), dir, ["install"], repo, { kind: "mise-install", repo }, signal);
  }

  /**
   * The task's current run once the system has confirmed its end, or after `timeoutMs` (then still `running` or
   * `stopping`), for an agent waiting for the result (`wait_for_mise_task`, ADR-41). `signal` (the client cancelled
   * the call) ends the wait but does not stop the task.
   */
  async waitForEnd(repo: string, miseTask: string, timeoutMs: number, signal: AbortSignal): Promise<RunState> {
    await this.deps.repos.repoPath(repo);
    const groupOwner = owner(repo, miseTask);
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
      if (!run) throw notRun(repo, miseTask);
      return run;
    } finally {
      giveUp.removeEventListener("abort", stopWaiting);
    }
  }

  async stop(repo: string, miseTask: string): Promise<RunState> {
    await this.deps.repos.repoPath(repo);
    const stopped = await this.deps.procs.stop(owner(repo, miseTask));
    if (!stopped) throw notRun(repo, miseTask);
    return stopped;
  }

  /** `mise trust` bez ścieżki ufa konfiguracji w korzeniu repo, nie w katalogach nadrzędnych. */
  async trust(repo: string): Promise<MiseTasks> {
    const dir = await this.deps.repos.repoPath(repo);
    const result = await runMiseCli(this.deps.command, ["trust"], dir, await this.deps.env());
    if (result.kind !== "exited") throw new DomainError("mise_unavailable", result.message);
    if (result.code !== 0) throw new DomainError("mise_unavailable", failure(result.stderr, result.code));
    return this.tasks(repo);
  }

  private async hasTask(dir: string, miseTask: string): Promise<boolean> {
    const listed = await this.list(dir);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", listed.message);
    return listed.tasks.some((t) => t.name === miseTask);
  }

  /** Task uruchomiony w tym działaniu daemona: lista pokaże go do zatrzymania, nawet gdy zniknie z konfiguracji. */
  private remember(repo: string, miseTask: string): void {
    const names = this.started.get(repo) ?? new Set<string>();
    this.started.set(repo, names.add(miseTask));
  }

  private async launch(groupOwner: string, dir: string, args: readonly string[], repo: string, logSource: LogSource): Promise<RunState> {
    try {
      return await this.deps.procs.start({
        owner: groupOwner,
        command: [...this.deps.command, ...args],
        cwd: dir,
        env: await this.deps.env(),
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
    dir: string,
    args: readonly string[],
    repo: string,
    logSource: LogSource,
    signal: AbortSignal,
  ): Promise<RunState> {
    signal.throwIfAborted();
    await this.launch(groupOwner, dir, args, repo, logSource);
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

  private async list(dir: string): Promise<TaskList> {
    const result = await runMiseCli(this.deps.command, ["tasks", "ls", "--json"], dir, await this.deps.env());
    return parseTaskList(result);
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

function notRun(repo: string, miseTask: string): DomainError {
  return new DomainError("not_found", `mise task "${miseTask}" in ${repo} has not been run`);
}

/** Klucz właściciela grupy w `procs`; tylko budowany, nigdy rozbierany z powrotem. */
function owner(repo: string, miseTask: string): string {
  return `mise:${repo}:${miseTask}`;
}

/** Źródło logu taska: ta sama para (repo, task mise) co właściciel grupy, w kształcie z kontraktu `logs`. */
function taskLogSource(repo: string, miseTask: string): LogSource {
  return { kind: "mise-task", repo, miseTask };
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

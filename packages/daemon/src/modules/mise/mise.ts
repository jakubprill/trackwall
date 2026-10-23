import { type MiseTask, MiseTaskName, type MiseTasks, type RunState } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, SpawnFailure } from "../../errors.ts";
import { type MiseCliResult, runMiseCli } from "./mise-cli.ts";

/**
 * Moduł `mise` (§4, ADR-20): taski mise repo z workspace i ich uruchomienia. Lista pochodzi z `mise tasks ls --json`
 * przy każdym zapytaniu, więc zmiana `mise.toml` widać od razu. Uruchomienie to `mise run <task>` w korzeniu repo,
 * w grupie procesów modułu `procs`; daemon uruchamia tylko task, który jest na aktualnej liście (§1.2).
 */

/** Czego `mise` potrzebuje od `procs`; podłączane w fasadzie. */
interface MiseProcs {
  start(spec: { owner: string; command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<RunState>;
  state(owner: string): RunState | undefined;
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

  /**
   * Działające taski repo spoza listy: usunięte z konfiguracji w trakcie działania albo pokazane, gdy mise listy
   * nie podał. Bez nich nie dałoby się ich zatrzymać z UI.
   */
  private liveOutside(repo: string, listed: readonly ListedMiseTask[]): MiseTask[] {
    const live: MiseTask[] = [];
    for (const name of this.started.get(repo) ?? []) {
      const run = this.deps.procs.state(owner(repo, name));
      if (run && run.kind !== "exited" && !listed.some((t) => t.name === name)) live.push({ name, description: "", run });
    }
    return live;
  }

  async start(repo: string, miseTask: string): Promise<RunState> {
    const dir = await this.deps.repos.repoPath(repo);
    const listed = await this.list(dir);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", listed.message);
    if (!listed.tasks.some((t) => t.name === miseTask)) throw new DomainError("not_found", `repo ${repo} nie ma taska mise "${miseTask}"`);
    let run: RunState;
    try {
      run = await this.deps.procs.start({
        owner: owner(repo, miseTask),
        command: [...this.deps.command, "run", miseTask],
        cwd: dir,
        env: await this.deps.env(),
      });
    } catch (err) {
      if (!(err instanceof SpawnFailure)) throw err;
      throw new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "mise_unavailable", `${repo}: ${err.message}`);
    }
    const names = this.started.get(repo) ?? new Set<string>();
    this.started.set(repo, names.add(miseTask));
    return run;
  }

  async stop(repo: string, miseTask: string): Promise<RunState> {
    const stopped = await this.deps.procs.stop(owner(repo, miseTask));
    if (!stopped) throw new DomainError("not_found", `task mise "${miseTask}" w ${repo} nie był uruchamiany`);
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
    return { kind: "error", message: "mise tasks ls --json zwrócił coś, co nie jest JSON-em" };
  }
  const parsed = ListedTasks.safeParse(json);
  if (!parsed.success) return { kind: "error", message: `nieoczekiwany format mise tasks ls --json: ${z.prettifyError(parsed.error)}` };
  const tasks = parsed.data
    .filter((t) => !t.hide && MiseTaskName.safeParse(t.name).success)
    .map((t) => ({ name: t.name, description: t.description ?? "" }));
  return { kind: "ok", tasks };
}

/** Klucz właściciela grupy w `procs`; tylko budowany, nigdy rozbierany z powrotem. */
function owner(repo: string, miseTask: string): string {
  return `mise:${repo}:${miseTask}`;
}

/** Komunikat błędu mise bez ostrzeżeń, które nie są przyczyną (np. nieudane sprawdzenie nowej wersji). */
function failure(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^mise WARN/.test(l));
  return lines.join("\n") || `mise zakończył się kodem ${code}`;
}

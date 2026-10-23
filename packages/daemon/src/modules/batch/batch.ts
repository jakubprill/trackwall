import { realpath } from "node:fs/promises";
import {
  BATCH_STEPS,
  type BatchRepo,
  type BatchRequest,
  type BatchRun,
  type BatchStep,
  type BatchStepState,
  type RunState,
  type SyncResult,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../errors.ts";
import { mapLimit } from "../../map-limit.ts";
import { runOutcome, syncOutcome } from "./step-outcome.ts";

/**
 * Moduł `batch` (§4.8, ADR-27): komenda zbiorcza, czyli wybrane kroki (synchronizacja, `mise install`, taski mise
 * `setup` i `build`) na wybranych repo, kilka repo naraz, a w repo krok po kroku. Składa moduły `workspace` i `mise`
 * ponad nimi i nie uruchamia niczego sam: procesy startuje `mise` przez `procs`, więc taski są widoczne i do
 * zatrzymania także w karcie repo. Powtórka jest tania dzięki cache mise (`sources` i `outputs` tasku), nie własnemu.
 * Trzymana tylko w pamięci, jak synchronizacja; naraz trwa jedna.
 */

/**
 * Ile katalogów naraz: build Javy albo frontendu zajmuje kilka rdzeni i GB pamięci, a `mise install` pobiera JDK
 * i Node; więcej równoległych repo na laptopie tylko wydłuża każde z nich.
 */
const BATCH_CONCURRENCY = 3;

/** Krok, który jest taskiem mise, i nazwa tego taska (konwencja z `CONTEXT.md`, „Task mise”). */
const MISE_TASK = { setup: "setup", build: "build" } as const satisfies Partial<Record<BatchStep, string>>;

/** Czego `batch` potrzebuje od `workspace`; podłączane w fasadzie (§4). */
interface BatchWorkspace {
  repoPath(id: string): Promise<string>;
  syncRepo(id: string): Promise<SyncResult>;
}

/** Czego `batch` potrzebuje od `mise`: uruchomienie doczekane do końca, przerywane sygnałem. */
interface BatchMise {
  installTools(repo: string, signal: AbortSignal): Promise<RunState>;
  runToEnd(repo: string, miseTask: string, signal: AbortSignal): Promise<RunState | null>;
}

export interface BatchDeps {
  workspace: BatchWorkspace;
  mise: BatchMise;
  log: (msg: string) => void;
}

interface Active {
  run: BatchRun;
  abort: AbortController;
}

export class Batch {
  private readonly deps: BatchDeps;
  private last: Active | undefined;
  /** Start w toku (repo są jeszcze sprawdzane): drugi start w tym czasie zacząłby drugą komendę. */
  private starting = false;
  /** Daemon się zatrzymuje: komenda zaczęta teraz uruchamiałaby procesy po `stopAll`. */
  private closed = false;

  constructor(deps: BatchDeps) {
    this.deps = deps;
  }

  /** Zaczyna komendę w tle i od razu ją zwraca; nieznane repo odrzuca całe żądanie, zanim cokolwiek ruszy. */
  async start(request: BatchRequest): Promise<BatchRun> {
    if (this.starting || this.last?.run.finishedAt === null)
      throw new DomainError("bad_request", "trwa komenda zbiorcza; poczekaj na jej koniec albo ją przerwij");
    this.starting = true;
    try {
      const targets = await Promise.all(request.repos.map(async (repo) => ({ repo, path: await this.deps.workspace.repoPath(repo) })));
      const steps = BATCH_STEPS.filter((step) => request.steps.includes(step));
      const run: BatchRun = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        cancelled: false,
        repos: targets.map((target) => ({ ...target, steps: steps.map((step) => ({ step, state: "waiting" })) })),
      };
      const groups = await groupBySameDir(run.repos);
      if (this.closed) throw new DomainError("bad_request", "daemon się zatrzymuje");
      const abort = new AbortController();
      this.last = { run, abort };
      void mapLimit(groups, BATCH_CONCURRENCY, async (repos) => {
        for (const repo of repos) await this.runRepo(repo, abort.signal);
      })
        .catch((err: unknown) => this.deps.log(`komenda zbiorcza: ${messageOf(err)}`))
        .finally(() => {
          run.finishedAt = new Date().toISOString();
        });
      return snapshot(run);
    } finally {
      this.starting = false;
    }
  }

  /** Ostatnia komenda od startu daemona. */
  run(): BatchRun | null {
    return this.last ? snapshot(this.last.run) : null;
  }

  /**
   * Przerywa trwającą komendę: kroki, które się nie zaczęły, kończą się jako `cancelled`, a trwające procesy `mise`
   * zatrzymuje stop grupy. Trwająca synchronizacja repo kończy się sama, bo git nie jest w grupie procesów.
   */
  cancel(): BatchRun | null {
    if (this.last?.run.finishedAt === null) {
      this.last.run.cancelled = true;
      this.last.abort.abort();
    }
    return this.run();
  }

  /** Wyjście daemona: przerywa trwającą komendę i nie pozwala zacząć nowej, także takiej, która właśnie startuje. */
  close(): void {
    this.closed = true;
    this.cancel();
  }

  /** Kroki repo po kolei; błąd albo przerwanie kroku kończy repo, a pominięcie (np. brak taska) nie. */
  private async runRepo(repo: BatchRepo, signal: AbortSignal): Promise<void> {
    let stopped: BatchStepState | undefined;
    for (const [i, { step }] of repo.steps.entries()) {
      if (signal.aborted) stopped = { state: "cancelled" };
      if (stopped) {
        repo.steps[i] = { step, ...stopped };
        continue;
      }
      repo.steps[i] = { step, state: "running" };
      const outcome = await this.runStep(repo, step, signal);
      repo.steps[i] = { step, ...outcome };
      if (outcome.state === "failed") stopped = { state: "skipped", message: `pominięty po błędzie kroku ${step}` };
      if (outcome.state === "cancelled") stopped = outcome;
    }
  }

  private async runStep({ repo, path }: BatchRepo, step: BatchStep, signal: AbortSignal): Promise<BatchStepState> {
    try {
      // Identyfikator z nazwy katalogu może przejść na inny katalog w trakcie komendy (ADR-18); krok idzie tylko
      // w repo, które użytkownik widzi w wynikach.
      if ((await this.deps.workspace.repoPath(repo)) !== path)
        return { state: "failed", message: `${repo} wskazuje teraz inny katalog niż ${path}`, lastLines: [] };
      switch (step) {
        case "sync":
          return syncOutcome(await this.deps.workspace.syncRepo(repo));
        case "tools":
          return runOutcome(await this.deps.mise.installTools(repo, signal));
        case "setup":
        case "build": {
          const run = await this.deps.mise.runToEnd(repo, MISE_TASK[step], signal);
          return run ? runOutcome(run) : { state: "skipped", message: `repo nie ma taska mise ${MISE_TASK[step]}` };
        }
      }
    } catch (err) {
      // Tylko przerwanie przed startem procesu; błąd stopu po przerwaniu (`stop_unconfirmed`) jest błędem kroku.
      if (err === signal.reason) return { state: "cancelled" };
      return { state: "failed", message: messageOf(err), lastLines: [] };
    }
  }
}

/**
 * Repo pogrupowane po katalogu na dysku: dowiązanie w folderze z projektami do innego repo z listy to
 * osobny wpis, a dwa `pnpm install` albo buildy naraz w jednym katalogu psują sobie nawzajem pliki. Wpisy jednej
 * grupy idą po kolei, grupy równolegle. Bez wielkości liter, jak dyski Windowsa i macOS.
 */
async function groupBySameDir(repos: readonly BatchRepo[]): Promise<BatchRepo[][]> {
  const keyed = await Promise.all(
    repos.map(async (repo) => ({ repo, key: (await realpath(repo.path).catch(() => repo.path)).toLowerCase() })),
  );
  const groups = new Map<string, BatchRepo[]>();
  for (const { repo, key } of keyed) groups.set(key, [...(groups.get(key) ?? []), repo]);
  return [...groups.values()];
}

/** Kopia dla wołającego: komenda zmienia się w tle, a wynik ma pokazać jedną chwilę. */
function snapshot(run: BatchRun): BatchRun {
  return { ...run, repos: run.repos.map((repo) => ({ ...repo, steps: [...repo.steps] })) };
}

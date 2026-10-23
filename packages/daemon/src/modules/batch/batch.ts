import {
  BATCH_STEPS,
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
 * Ile repo naraz: build Javy albo frontendu zajmuje kilka rdzeni i GB pamięci, a `mise install` pobiera JDK
 * i Node; więcej równoległych repo na laptopie tylko wydłuża każde z nich.
 */
const BATCH_CONCURRENCY = 3;

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
        steps,
        repos: targets.map((target) => ({ ...target, steps: steps.map((step) => ({ step, state: "waiting" })) })),
      };
      const active: Active = { run, abort: new AbortController() };
      this.last = active;
      void mapLimit(run.repos, BATCH_CONCURRENCY, (_, i) => this.runRepo(active, i)).finally(() => {
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

  /** Kroki repo po kolei; błąd albo przerwanie kroku kończy repo, a pominięcie (np. brak taska) nie. */
  private async runRepo(active: Active, index: number): Promise<void> {
    const repo = active.run.repos[index];
    if (!repo) throw new Error(`komenda zbiorcza bez repo nr ${index}`);
    let stopped: BatchStepState | undefined;
    for (const [i, { step }] of repo.steps.entries()) {
      if (active.abort.signal.aborted) stopped = { state: "cancelled" };
      if (stopped) {
        repo.steps[i] = { step, ...stopped };
        continue;
      }
      repo.steps[i] = { step, state: "running" };
      const outcome = await this.runStep(repo.repo, step, active.abort.signal);
      repo.steps[i] = { step, ...outcome };
      if (outcome.state === "failed") stopped = { state: "skipped", message: `pominięty po błędzie kroku ${step}` };
      if (outcome.state === "cancelled") stopped = outcome;
    }
  }

  private async runStep(repo: string, step: BatchStep, signal: AbortSignal): Promise<BatchStepState> {
    try {
      if (step === "sync") return syncOutcome(await this.deps.workspace.syncRepo(repo));
      if (step === "tools") return runOutcome(await this.deps.mise.installTools(repo, signal));
      const run = await this.deps.mise.runToEnd(repo, step, signal);
      return run ? runOutcome(run) : { state: "skipped", message: `repo nie ma taska mise ${step}` };
    } catch (err) {
      if (signal.aborted) return { state: "cancelled" };
      return { state: "failed", message: messageOf(err), lastLines: [] };
    }
  }
}

/** Kopia dla wołającego: komenda zmienia się w tle, a wynik ma pokazać jedną chwilę. */
function snapshot(run: BatchRun): BatchRun {
  return { ...run, repos: run.repos.map((repo) => ({ ...repo, steps: [...repo.steps] })) };
}

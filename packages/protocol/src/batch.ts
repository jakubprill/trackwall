import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `batch` (§4.8, ADR-27): komenda zbiorcza, czyli te same kroki na wielu repo naraz, z wynikiem
 * każdego kroku w każdym repo. Klient wybiera repo po identyfikatorach i kroki z listy; komendy składa daemon (§1.2).
 * Trzymana tylko w pamięci daemona, jak synchronizacja.
 */

/**
 * Krok komendy zbiorczej, w kolejności wykonania w repo: synchronizacja (ADR-21), narzędzia z konfiguracji mise
 * repo (`mise install`), zależności (task mise `setup`) i build (task mise `build`).
 */
export const BatchStep = z.enum(["sync", "tools", "setup", "build"]);
export type BatchStep = z.infer<typeof BatchStep>;

/** Kolejność kroków w repo, niezależnie od kolejności w żądaniu: build po zależnościach, zależności po narzędziach. */
export const BATCH_STEPS: readonly BatchStep[] = BatchStep.options;

export const BatchStepState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting") }),
  z.object({ state: z.literal("running") }),
  /** `detail`: wynik synchronizacji (gałąź i liczba nowych commitów); przy krokach mise `null`. */
  z.object({ state: z.literal("done"), detail: z.string().nullable() }),
  /**
   * Krok nie miał czego zrobić albo nie mógł: synchronizacja pominięta z powodem (repo i tak idzie dalej), repo bez
   * taska mise albo wcześniejszy krok tego repo zakończył się błędem.
   */
  z.object({ state: z.literal("skipped"), message: z.string() }),
  /** `lastLines`: koniec wyjścia procesu, gdy krok był procesem; komunikat gita albo mise ma tylko `message`. */
  z.object({ state: z.literal("failed"), message: z.string(), lastLines: z.array(z.string()) }),
  /** Przerwany przez użytkownika (przerwanie komendy, stop taska w karcie repo albo wyjście daemona). */
  z.object({ state: z.literal("cancelled") }),
]);
export type BatchStepState = z.infer<typeof BatchStepState>;

export const BatchStepResult = z.intersection(z.object({ step: BatchStep }), BatchStepState);
export type BatchStepResult = z.infer<typeof BatchStepResult>;

export const BatchRepo = z.object({
  /** Identyfikator repo w chwili startu (ADR-18: może się zmienić razem z nazwą katalogu). */
  repo: RepoId,
  path: z.string(),
  /** Wybrane kroki w kolejności `BATCH_STEPS`. */
  steps: z.array(BatchStepResult),
});
export type BatchRepo = z.infer<typeof BatchRepo>;

export const BatchRun = z.object({
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null`, dopóki któreś repo czeka albo trwa. */
  finishedAt: z.string().nullable(),
  /** Użytkownik przerwał komendę: kroki, które nie zaczęły się przed przerwaniem, są `cancelled`. */
  cancelled: z.boolean(),
  /** Wybrane repo w kolejności z żądania. */
  repos: z.array(BatchRepo),
});
export type BatchRun = z.infer<typeof BatchRun>;

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

export const BatchRequest = z
  .object({
    /** Repo do objęcia komendą; wybór (ręcznie, później po tagach) robi klient. */
    repos: z.array(RepoId).min(1, "wybierz co najmniej jedno repo").refine(unique, "repo powtarza się na liście"),
    steps: z.array(BatchStep).min(1, "wybierz co najmniej jeden krok").refine(unique, "krok powtarza się na liście"),
  })
  .strict();
export type BatchRequest = z.infer<typeof BatchRequest>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/batch/${action}`, request, data };
}

export const batchApi = {
  /** Zaczyna komendę zbiorczą w tle i od razu ją zwraca; gdy inna trwa, `bad_request`. Postęp przez `run`. */
  start: endpoint("start", BatchRequest, BatchRun),
  /** Ostatnia komenda zbiorcza od startu daemona; `null`, gdy jej nie było. */
  run: endpoint("run", z.object({}).strict(), BatchRun.nullable()),
  /**
   * Przerywa trwającą komendę: repo, które czekają, i kroki, które się nie zaczęły, nie ruszą, a działające taski mise
   * są zatrzymywane jak stopem z karty repo. Trwającego kroku synchronizacji nie da się przerwać, kończy się sam.
   */
  cancel: endpoint("cancel", z.object({}).strict(), BatchRun.nullable()),
};

import { z } from "zod";

/**
 * Synchronizacja wszystkich repo z folderu z projektami (§4.5, §7 „`ws sync`”, ADR-21): fetch i fast-forward gałęzi
 * domyślnej, w tle, z wynikiem per repo. Trzymana tylko w pamięci daemona, jak klonowania.
 */

/**
 * Dlaczego gałąź domyślna nie została przesunięta, choć fetch mógł się udać. Każdy powód zostawia repo nietknięte:
 * synchronizacja nigdy nie scala, nie robi rebase ani nie nadpisuje lokalnych zmian.
 */
export const SyncSkipReason = z.enum([
  /** Repo nie ma `origin` ani jedynego innego remote. */
  "no-remote",
  /** Remote nie mówi, która gałąź jest domyślna (brak `refs/remotes/<remote>/HEAD` także po `remote set-head --auto`). */
  "no-default-branch",
  /** Gałęzi domyślnej nie ma lokalnie; fetch pobrał zmiany, ale nie ma czego przesuwać. */
  "no-local-branch",
  /** Gałąź domyślna jest wybrana, a w katalogu roboczym są zmiany w śledzonych plikach. */
  "dirty",
  /** Lokalna gałąź domyślna ma commity, których nie ma na zdalnym, i odwrotnie; trzeba scalić ręcznie. */
  "diverged",
  /** Lokalna gałąź domyślna ma tylko commity, których nie ma na zdalnym (niewypchnięte); zdalny nie ma nic nowego. */
  "ahead",
  /** Gałąź domyślna jest wybrana w innym worktree tego repo; przesunięcie zmieniłoby jego katalog roboczy pod spodem. */
  "checked-out-elsewhere",
]);
export type SyncSkipReason = z.infer<typeof SyncSkipReason>;

/** Wynik synchronizacji jednego repo, gdy już się skończyła. */
export const SyncOutcome = z.discriminatedUnion("state", [
  /** Gałąź domyślna przesunięta do zdalnej o `commits` commitów. */
  z.object({ state: z.literal("updated"), branch: z.string(), commits: z.number().int().positive() }),
  /** Fetch się udał, a gałąź domyślna już była równa zdalnej. */
  z.object({ state: z.literal("up-to-date"), branch: z.string() }),
  /** `message` to zdanie dla użytkownika, z nazwą gałęzi, gdy jest znana. */
  z.object({ state: z.literal("skipped"), reason: SyncSkipReason, message: z.string() }),
  /** Git odmówił (sieć, logowanie, klucz hosta, limit czasu); `message` to komunikat gita. */
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
export type SyncOutcome = z.infer<typeof SyncOutcome>;

const SyncTarget = z.object({
  /** Identyfikator repo w chwili startu synchronizacji (ADR-18: może się zmienić razem z nazwą katalogu). */
  repo: z.string(),
  path: z.string(),
});

/** Jedno repo w synchronizacji: czeka na wolne miejsce, trwa albo ma wynik. */
export const SyncRepo = z.union([SyncTarget.extend({ state: z.enum(["waiting", "running"]) }), z.intersection(SyncTarget, SyncOutcome)]);
export type SyncRepo = z.infer<typeof SyncRepo>;

export const SyncRun = z.object({
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null`, dopóki któreś repo czeka albo trwa. */
  finishedAt: z.string().nullable(),
  /** Repo z folderu z projektami w chwili startu, w kolejności listy repo. */
  repos: z.array(SyncRepo),
});
export type SyncRun = z.infer<typeof SyncRun>;

import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { MiseTaskName } from "./mise.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `logs` (§4.2, ADR-28): rekordy wyjścia procesów z globalnym numerem `seq` i odczyt od kursora.
 * Każda akcja to `POST /api/logs/<akcja>`. Rekord jest już zamaskowany i bez sekwencji ANSI.
 */

/** Ile rekordów daemon trzyma w pamięci na źródło; starsze są tylko w pliku JSONL. */
export const LOG_BUFFER_RECORDS = 2000;
/** Najwięcej rekordów w jednej odpowiedzi `tail`. */
export const LOG_TAIL_MAX = 1000;

/** Skąd pochodzi rekord. Dziś tylko task mise repo; serwisy, zadania i daemon dojdą z tymi modułami. */
export const LogSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mise-task"), repo: RepoId, miseTask: MiseTaskName }).strict(),
]);
export type LogSource = z.infer<typeof LogSource>;

export const LogLevel = z.enum(["trace", "debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

export const LogStream = z.enum(["stdout", "stderr"]);
export type LogStream = z.infer<typeof LogStream>;

export const LogRecord = z.object({
  /** Globalny numer rekordu, rosnący dla wszystkich źródeł w jednym działaniu daemona. */
  seq: z.number().int().positive(),
  /** ISO 8601, chwila odebrania linii przez daemon. */
  ts: z.string(),
  /** Uruchomienie (`RunState.runId`), z którego pochodzi linia; źródło ma rekordy wielu uruchomień. */
  runId: z.string(),
  stream: LogStream,
  /** Z treści linii (słowa `ERROR`, `WARN`…), nie ze strumienia: wiele narzędzi pisze zwykły postęp na stderr. */
  level: LogLevel,
  msg: z.string(),
});
export type LogRecord = z.infer<typeof LogRecord>;

export const LogTail = z.object({
  /** Od najstarszego do najnowszego. */
  records: z.array(LogRecord),
  /** Kursor do następnego pytania (`sinceSeq`). */
  nextSeq: z.number().int().nonnegative(),
  /**
   * Część rekordów po kursorze przepadła: wypadły z bufora albo kursor pochodzi z poprzedniego działania daemona.
   * Klient zaczyna wtedy od tego, co dostał, zamiast doklejać.
   */
  dropped: z.boolean(),
});
export type LogTail = z.infer<typeof LogTail>;

const LogTailRequest = z
  .object({
    source: LogSource,
    /** Rekordy z `seq` większym niż kursor, od najstarszego; bez kursora ostatnie `limit` rekordów źródła. */
    sinceSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(LOG_TAIL_MAX),
  })
  .strict();

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/logs/${action}`, request, data };
}

export const logsApi = {
  tail: endpoint("tail", LogTailRequest, LogTail),
};

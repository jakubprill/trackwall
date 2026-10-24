import {
  LOG_BUFFER_RECORDS,
  type LogErrors,
  type LogErrorsRequest,
  type LogRecord,
  type LogSource,
  type LogStream,
  type LogTail,
  type LogTailRequest,
} from "@trackwall/protocol";
import { collectErrors } from "./log-errors.ts";
import { LogFile, logFilePath, sourceParts } from "./log-file.ts";
import { logLevel } from "./log-level.ts";
import { RunOutput } from "./run-output.ts";
import { secretValues } from "./secret-mask.ts";

/**
 * Moduł `logs` (§4.2, ADR-28): linie wyjścia procesów jako rekordy z jednym globalnym `seq` dla wszystkich źródeł.
 * Każde źródło ma bufor ostatnich rekordów w pamięci (dla UI i MCP, odczyt od kursora) i plik JSONL w katalogu
 * stanu. Linia jest maskowana i oczyszczana z ANSI w `RunOutput`, zanim trafi do bufora albo pliku.
 */

/** Zapis do plików paczkami: głośny proces daje setki linii na sekundę. */
const FLUSH_DELAY_MS = 250;
/** Bufor źródła ma też limit treści: 2000 długich linii (np. logów JSON) zajęłoby dziesiątki MB na task. */
const BUFFER_CHARS = 2 * 1024 * 1024;

export interface LogsDeps {
  /** Katalog plików JSONL (`<katalog stanu>/logs`). */
  dir: string;
  /** Limit jednego pliku JSONL przed rotacją. */
  maxFileBytes: number;
  log: (msg: string) => void;
}

interface SourceLog {
  readonly source: LogSource;
  readonly key: string;
  readonly records: LogRecord[];
  /** Suma długości `msg` rekordów w buforze. */
  chars: number;
  /** `seq` ostatniego rekordu, który wypadł z bufora; kursor starszy znaczy, że coś przepadło. */
  evictedSeq: number;
  readonly file: LogFile;
  /** Błąd zapisu pliku już zgłoszony w logu daemona; zgłaszany raz, do następnego udanego zapisu. */
  writeErrorReported: boolean;
  /** Pełny bufor zapisu (rekordy nie trafiają do pliku) już zgłoszony; też raz, do następnego udanego zapisu. */
  overflowReported: boolean;
}

export class Logs {
  private readonly deps: LogsDeps;
  private readonly sources = new Map<string, SourceLog>();
  /**
   * Pierwszy `seq` tego działania daemona minus jeden: chwila startu w ms razy 1000. Kursor mniejszy pochodzi
   * z wcześniejszego działania; tysiąc rekordów na milisekundę działania to więcej, niż wypisze jakikolwiek proces,
   * a wartość mieści się w `Number.MAX_SAFE_INTEGER` do ok. 2255 roku.
   */
  private readonly baseSeq = Date.now() * 1000;
  private seq = this.baseSeq;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: LogsDeps) {
    this.deps = deps;
  }

  /**
   * Wyjście nowego uruchomienia źródła. Sekretami do maskowania są wartości ze środowiska procesu (`secretValues`);
   * samo środowisko nie trafia nigdzie dalej.
   */
  open(source: LogSource, runId: string, env: NodeJS.ProcessEnv): RunOutput {
    const log = this.sourceLog(source);
    return new RunOutput(secretValues(env), (stream, msg) => this.append(log, source, { runId, stream, msg }));
  }

  /** Wyjście tylko do ostatnich linii stanu, zamaskowane tak samo, ale bez logu (ekran PTY sesji zadania). */
  lastLinesOnly(env: NodeJS.ProcessEnv): RunOutput {
    return new RunOutput(secretValues(env), () => {});
  }

  /**
   * Rekordy źródła po kursorze, od najstarszego, najwyżej `limit`. Bez kursora (albo z kursorem z innego działania
   * daemona) ostatnie `limit` rekordów.
   */
  tail({ source, sinceSeq, limit }: LogTailRequest): LogTail {
    const log = this.sources.get(sourceKey(source));
    const records = log?.records ?? [];
    const fromOtherRun = this.fromOtherRun(sinceSeq);
    if (sinceSeq === undefined || fromOtherRun) return { records: records.slice(-limit), nextSeq: this.seq, dropped: fromOtherRun };
    const start = records.findIndex((r) => r.seq > sinceSeq);
    const page = start === -1 ? [] : records.slice(start, start + limit);
    const last = page.at(-1);
    const more = start !== -1 && start + limit < records.length;
    return { records: page, nextSeq: more && last ? last.seq : this.seq, dropped: sinceSeq < (log?.evictedSeq ?? 0) };
  }

  /**
   * Errors from the buffers of the sources matching `repo` and `miseTask` (ADR-42), most recent first. The cursor
   * covers all sources at once because `seq` is global; a cursor from another daemon run gives errors as without one.
   */
  errors({ repo, miseTask, minLevel, sinceSeq, limit }: LogErrorsRequest): LogErrors {
    const sources = [...this.sources.values()].filter(
      ({ source }) =>
        (repo === undefined || source.repo === repo) &&
        (miseTask === undefined || (source.kind === "mise-task" && source.miseTask === miseTask)),
    );
    const fromOtherRun = this.fromOtherRun(sinceSeq);
    const cursor = fromOtherRun ? undefined : sinceSeq;
    const evicted = cursor !== undefined && sources.some((log) => cursor < log.evictedSeq);
    return { ...collectErrors(sources, { minLevel, sinceSeq: cursor, limit }), nextSeq: this.seq, dropped: fromOtherRun || evicted };
  }

  /** Zapisuje bufory plików; wołane z opóźnieniem po nowych rekordach i przy wyjściu daemona. */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const log of this.sources.values()) {
      try {
        log.file.flush();
        log.writeErrorReported = false;
        log.overflowReported = false;
      } catch (err) {
        if (!log.writeErrorReported) this.deps.log(`writing ${log.file.path}: ${String(err)}; will retry`);
        log.writeErrorReported = true;
      }
    }
    if ([...this.sources.values()].some((l) => l.file.hasPending)) this.scheduleFlush();
  }

  private append(log: SourceLog, source: LogSource, line: { runId: string; stream: LogStream; msg: string }): void {
    this.seq += 1;
    const record: LogRecord = { seq: this.seq, ts: new Date().toISOString(), ...line, level: logLevel(line.msg) };
    log.records.push(record);
    log.chars += record.msg.length;
    while (log.records.length > LOG_BUFFER_RECORDS || log.chars > BUFFER_CHARS) {
      const evicted = log.records.shift();
      if (!evicted) break;
      log.evictedSeq = evicted.seq;
      log.chars -= evicted.msg.length;
    }
    if (!log.file.append(JSON.stringify({ ...record, source })) && !log.overflowReported) {
      log.overflowReported = true;
      this.deps.log(`writing ${log.file.path} cannot keep up; records are not written to the file until the next successful write`);
    }
    this.scheduleFlush();
  }

  /** A cursor below the empty log's cursor, or above the last `seq` (the previous run's clock was ahead). */
  private fromOtherRun(sinceSeq: number | undefined): boolean {
    return sinceSeq !== undefined && (sinceSeq < this.baseSeq || sinceSeq > this.seq);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    // Opóźniony zapis nie trzyma procesu przy życiu; wyjście daemona woła `flush` samo.
    this.flushTimer.unref();
  }

  private sourceLog(source: LogSource): SourceLog {
    const key = sourceKey(source);
    let log = this.sources.get(key);
    if (!log) {
      const path = logFilePath(this.deps.dir, source);
      const file = new LogFile(path, this.deps.maxFileBytes, (err) =>
        this.deps.log(`rotating ${path}: ${String(err)}; the file grows past the limit until the next successful rotation`),
      );
      log = { source, key, records: [], chars: 0, evictedSeq: 0, file, writeErrorReported: false, overflowReported: false };
      this.sources.set(key, log);
    }
    return log;
  }
}

/** Klucz źródła w mapie; tylko budowany, nigdy rozbierany z powrotem. */
function sourceKey(source: LogSource): string {
  return sourceParts(source).join("\0");
}

import { LOG_BUFFER_RECORDS, type LogRecord, type LogSource, type LogStream, type LogTail } from "@trackwall/protocol";
import { LogFile, logFilePath } from "./log-file.ts";
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

export interface LogsDeps {
  /** Katalog plików JSONL (`<katalog stanu>/logs`). */
  dir: string;
  /** Limit jednego pliku JSONL przed rotacją. */
  maxFileBytes: number;
  log: (msg: string) => void;
}

interface SourceLog {
  readonly records: LogRecord[];
  /** `seq` ostatniego rekordu, który wypadł z bufora; kursor starszy znaczy, że coś przepadło. */
  evictedSeq: number;
  readonly file: LogFile;
  /** Błąd zapisu tego pliku jest zgłaszany raz, do następnego udanego zapisu. */
  failing: boolean;
}

export interface TailQuery {
  source: LogSource;
  sinceSeq?: number;
  limit: number;
}

export class Logs {
  private readonly deps: LogsDeps;
  private readonly sources = new Map<string, SourceLog>();
  private seq = 0;
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

  /**
   * Rekordy źródła po kursorze, od najstarszego, najwyżej `limit`. Bez kursora (albo z kursorem z poprzedniego
   * działania daemona, większym niż ostatni `seq`) ostatnie `limit` rekordów.
   */
  tail({ source, sinceSeq, limit }: TailQuery): LogTail {
    const log = this.sources.get(sourceKey(source));
    const records = log?.records ?? [];
    const fromOtherRun = sinceSeq !== undefined && sinceSeq > this.seq;
    if (sinceSeq === undefined || fromOtherRun) return { records: records.slice(-limit), nextSeq: this.seq, dropped: fromOtherRun };
    const start = records.findIndex((r) => r.seq > sinceSeq);
    const page = start === -1 ? [] : records.slice(start, start + limit);
    const last = page.at(-1);
    const more = start !== -1 && start + limit < records.length;
    return { records: page, nextSeq: more && last ? last.seq : this.seq, dropped: sinceSeq < (log?.evictedSeq ?? 0) };
  }

  /** Zapisuje bufory plików; wołane z opóźnieniem po nowych rekordach i przy wyjściu daemona. */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const log of this.sources.values()) {
      try {
        log.file.flush();
        log.failing = false;
      } catch (err) {
        if (!log.failing) this.deps.log(`zapis ${log.file.path}: ${String(err)}; spróbuję ponownie`);
        log.failing = true;
      }
    }
    if ([...this.sources.values()].some((l) => l.file.hasPending)) this.scheduleFlush();
  }

  private append(log: SourceLog, source: LogSource, line: { runId: string; stream: LogStream; msg: string }): void {
    this.seq += 1;
    const record: LogRecord = { seq: this.seq, ts: new Date().toISOString(), ...line, level: logLevel(line.msg) };
    log.records.push(record);
    if (log.records.length > LOG_BUFFER_RECORDS) log.evictedSeq = log.records.shift()?.seq ?? log.evictedSeq;
    if (!log.file.append(JSON.stringify({ ...record, source })) && !log.failing) {
      log.failing = true;
      this.deps.log(`zapis ${log.file.path} nie nadąża; rekordy giną do następnego udanego zapisu`);
    }
    this.scheduleFlush();
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
      log = { records: [], evictedSeq: 0, file: new LogFile(logFilePath(this.deps.dir, source), this.deps.maxFileBytes), failing: false };
      this.sources.set(key, log);
    }
    return log;
  }
}

/** Klucz źródła w mapie; tylko budowany, nigdy rozbierany z powrotem. */
function sourceKey(source: LogSource): string {
  return [source.kind, source.repo, source.miseTask].join("\0");
}

import {
  LOG_BUFFER_RECORDS,
  type LogErrors,
  type LogErrorsQuery,
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
import { maskSecrets, secretValues } from "./secret-mask.ts";

/**
 * The `logs` module (§4.2, ADR-28): process output lines as records with one global `seq` for all sources.
 * Every source has a buffer of recent records in memory (for the UI and MCP, read from a cursor) and a JSONL file in the state
 * directory. A line is masked and cleaned of ANSI in `RunOutput` before it reaches the buffer or the file.
 */

/** Writes to files in batches: a noisy process gives hundreds of lines per second. */
const FLUSH_DELAY_MS = 250;
/** A source's buffer also has a content limit: 2000 long lines (e.g. JSON logs) would take tens of MB per mise task. */
const BUFFER_CHARS = 2 * 1024 * 1024;

export interface LogsDeps {
  /** The directory of JSONL files (`<state directory>/logs`). */
  dir: string;
  /** The limit of one JSONL file before rotation. */
  maxFileBytes: number;
  log: (msg: string) => void;
}

interface SourceLog {
  readonly source: LogSource;
  readonly records: LogRecord[];
  /** The sum of `msg` lengths of the records in the buffer. */
  chars: number;
  /** The `seq` of the last record that fell out of the buffer; an older cursor means something was lost. */
  evictedSeq: number;
  readonly file: LogFile;
  /** A file write error already reported in the daemon log; reported once, until the next successful write. */
  writeErrorReported: boolean;
  /** A full write buffer (records do not reach the file) already reported; also once, until the next successful write. */
  overflowReported: boolean;
}

export class Logs {
  private readonly deps: LogsDeps;
  private readonly sources = new Map<string, SourceLog>();
  /**
   * The first `seq` of this daemon run minus one: the start time in ms times 1000. A smaller cursor comes
   * from an earlier run; a thousand records per millisecond of running is more than any process will print,
   * and the value fits in `Number.MAX_SAFE_INTEGER` until about the year 2255.
   */
  private readonly baseSeq = Date.now() * 1000;
  private seq = this.baseSeq;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: LogsDeps) {
    this.deps = deps;
  }

  /**
   * The output of a new run of a source. The secrets to mask are the values from the process environment and `secrets`,
   * the values the process gets elsewhere (`secretValues`); the environment itself is not passed on.
   */
  open(source: LogSource, runId: string, env: NodeJS.ProcessEnv, secrets: readonly string[] = []): RunOutput {
    const log = this.sourceLog(source);
    return new RunOutput(secretValues(env, secrets), (stream, msg) => this.append(log, source, { runId, stream, msg }));
  }

  /** A cursor before every record of this daemon run: `tail` from it pages from the oldest record still buffered. */
  runStartCursor(): number {
    return this.baseSeq;
  }

  /** Text from a process (an HTTP response of a service, ADR-45) masked the same way as its log lines. */
  mask(text: string, env: NodeJS.ProcessEnv): string {
    return maskSecrets(text, secretValues(env));
  }

  /** Output only for the state's last lines, masked the same way, but without a log (the PTY screen of a task session). */
  lastLinesOnly(env: NodeJS.ProcessEnv, secrets: readonly string[] = []): RunOutput {
    return new RunOutput(secretValues(env, secrets), () => {});
  }

  /**
   * A source's records after the cursor, oldest first, at most `limit`. Without a cursor (or with a cursor from another daemon
   * run) the last `limit` records.
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
   * Errors from the buffers of the sources matching `repo`, `task` and `miseTask` (ADR-42, ADR-59), most recent first.
   * The cursor covers all sources at once because `seq` is global; a cursor from another daemon run gives errors as
   * without one.
   */
  errors({ repo, task, miseTask, minLevel, sinceSeq, limit }: LogErrorsQuery): LogErrors {
    const sources = [...this.sources]
      .map(([key, log]) => ({ key, ...log }))
      .filter(
        ({ source }) =>
          (repo === undefined || source.repo === repo) &&
          (task === undefined || (source.kind === "task-mise-task" ? source.task === task : task === null)) &&
          (miseTask === undefined || (source.kind !== "mise-install" && source.miseTask === miseTask)),
      );
    const fromOtherRun = this.fromOtherRun(sinceSeq);
    const cursor = fromOtherRun ? undefined : sinceSeq;
    const evicted = cursor !== undefined && sources.some((log) => cursor < log.evictedSeq);
    return { ...collectErrors(sources, { minLevel, sinceSeq: cursor, limit }), nextSeq: this.seq, dropped: fromOtherRun || evicted };
  }

  /** Writes the file buffers; called with a delay after new records and on daemon exit. */
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
    // The delayed write does not keep the process alive; daemon exit calls `flush` itself.
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
      log = { source, records: [], chars: 0, evictedSeq: 0, file, writeErrorReported: false, overflowReported: false };
      this.sources.set(key, log);
    }
    return log;
  }
}

/** The source key in the map; only built, never taken apart again. */
function sourceKey(source: LogSource): string {
  return sourceParts(source).join("\0");
}

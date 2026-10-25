import { type LogStream, RUN_TAIL_LINES } from "@trackwall/protocol";
import { maskSecrets } from "./secret-mask.ts";
import { StreamLines, stripAnsi, visibleText } from "./stream-lines.ts";

/**
 * The output of one run (§4.2): stdout and stderr bytes as lines without ANSI and with masked secrets. Every
 * line goes to the source's log (`onLine`), and the last non-empty ones stay for the `exited` state (`RunState.lastLines`).
 * Masking comes before both paths, so neither the log nor the state sees a secret's value.
 */

/** The state's last lines are short, because they stand in the mise task's row; the full line is in the log. */
const LAST_LINE_CHARS = 500;
/** A log line has a limit, so that one line (e.g. a JSON dump) does not take the source's buffer. */
const RECORD_CHARS = 16 * 1024;

export class RunOutput {
  private readonly secrets: readonly string[];
  private readonly onLine: (stream: LogStream, msg: string) => void;
  private readonly streams: Record<LogStream, StreamLines>;
  private readonly last: string[] = [];

  constructor(secrets: readonly string[], onLine: (stream: LogStream, msg: string) => void) {
    this.secrets = secrets;
    this.onLine = onLine;
    this.streams = { stdout: new StreamLines(secrets), stderr: new StreamLines(secrets) };
  }

  push(stream: LogStream, chunk: Buffer): void {
    for (const raw of this.streams[stream].push(chunk)) this.add(stream, raw);
  }

  /** The end of the stream: an unfinished line goes to the log as the last one. */
  end(stream: LogStream): void {
    const raw = this.streams[stream].end();
    if (raw !== undefined) this.add(stream, raw);
  }

  /** The last non-empty lines, with the unfinished lines of both streams at the end. */
  lastLines(): string[] {
    const pending = [this.streams.stdout.pending(), this.streams.stderr.pending()].map((raw) => shorten(this.clean(raw), LAST_LINE_CHARS));
    return [...this.last, ...pending.filter((l) => l !== "")].slice(-RUN_TAIL_LINES);
  }

  private add(stream: LogStream, raw: string): void {
    const line = this.clean(raw);
    this.onLine(stream, shorten(line, RECORD_CHARS));
    if (line === "") return;
    this.last.push(shorten(line, LAST_LINE_CHARS));
    if (this.last.length > RUN_TAIL_LINES) this.last.shift();
  }

  private clean(raw: string): string {
    return visibleText(maskSecrets(stripAnsi(raw), this.secrets));
  }
}

/** The line cut to `max` characters, with `…` when it was longer. */
export function shorten(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

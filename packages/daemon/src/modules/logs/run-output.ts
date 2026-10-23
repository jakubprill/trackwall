import { type LogStream, RUN_TAIL_LINES } from "@trackwall/protocol";
import { maskSecrets } from "./secret-mask.ts";
import { StreamLines, stripAnsi, visibleText } from "./stream-lines.ts";

/**
 * Wyjście jednego uruchomienia (§4.2): bajty stdout i stderr jako linie bez ANSI i z zamaskowanymi sekretami. Każda
 * linia idzie do logu źródła (`onLine`), a ostatnie niepuste zostają dla stanu `exited` (`RunState.lastLines`).
 * Maskowanie jest przed obiema drogami, więc ani log, ani stan nie widzą wartości sekretu.
 */

/** Ostatnie linie stanu są krótkie, bo stoją w wierszu taska; pełna linia jest w logu. */
const LAST_LINE_CHARS = 500;
/** Linia w logu ma limit, żeby jedna linia (np. zrzut JSON) nie zajęła bufora źródła. */
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

  /** Koniec strumienia: niedokończona linia trafia do logu jako ostatnia. */
  end(stream: LogStream): void {
    const raw = this.streams[stream].end();
    if (raw !== undefined) this.add(stream, raw);
  }

  /** Ostatnie niepuste linie, z niedokończonymi liniami obu strumieni na końcu. */
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

function shorten(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

import { StringDecoder } from "node:string_decoder";
import { RUN_TAIL_LINES } from "@trackwall/protocol";

/**
 * Ostatnie linie wyjścia uruchomienia (stdout i stderr w kolejności przyjścia), pokazywane przy zakończonym
 * uruchomieniu zamiast pełnych logów. Każdy strumień ma własny dekoder i niedokończoną linię, żeby znak UTF-8 albo
 * linia rozcięte między kawałkami nie mieszały się z drugim strumieniem.
 */

const MAX_LINE_CHARS = 500;
// Sekwencje CSI i OSC: kolor i tytuł okna nic nie znaczą w tekście pokazanym w UI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC i BEL to właśnie to, co usuwamy.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

class StreamLines {
  private readonly decoder = new StringDecoder("utf8");
  partial = "";

  /** Pełne linie z kawałka; reszta czeka na następny. */
  push(chunk: Buffer): string[] {
    const lines = (this.partial + this.decoder.write(chunk)).split("\n");
    this.partial = lines.pop() ?? "";
    return lines;
  }
}

export class OutputTail {
  private readonly lines: string[] = [];
  private readonly streams = { stdout: new StreamLines(), stderr: new StreamLines() };

  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    for (const line of this.streams[stream].push(chunk)) this.add(line);
  }

  /** Ostatnie niepuste linie, z niedokończonymi liniami obu strumieni na końcu. */
  snapshot(): string[] {
    const pending = [this.streams.stdout.partial, this.streams.stderr.partial].map(clean).filter((l) => l !== "");
    return [...this.lines, ...pending].slice(-RUN_TAIL_LINES);
  }

  private add(raw: string): void {
    const line = clean(raw);
    if (line === "") return;
    this.lines.push(line);
    if (this.lines.length > RUN_TAIL_LINES) this.lines.shift();
  }
}

function clean(raw: string): string {
  // Postęp z `\r` nadpisuje linię w terminalu, więc liczy się to, co po ostatnim `\r`.
  const line = raw.replace(ANSI, "").replace(/\r+$/, "");
  const visible = line.slice(line.lastIndexOf("\r") + 1).trimEnd();
  return visible.length > MAX_LINE_CHARS ? `${visible.slice(0, MAX_LINE_CHARS)}…` : visible;
}

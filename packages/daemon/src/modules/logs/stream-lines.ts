import { StringDecoder } from "node:string_decoder";

/**
 * Bajty jednego strumienia (stdout albo stderr) jako linie tekstu widoczne w UI. Każdy strumień ma własny dekoder
 * i niedokończoną linię, żeby znak UTF-8 albo linia rozcięte między kawałkami nie mieszały się z drugim strumieniem.
 */

/**
 * Niedokończona linia dłuższa niż to idzie dalej jako linia: pasek postępu bez `\n` (tylko `\r`) rósłby w pamięci
 * przez cały czas działania procesu.
 */
const MAX_PARTIAL_CHARS = 64 * 1024;

// Sekwencje CSI i OSC: kolor i tytuł okna nic nie znaczą w tekście pokazanym w UI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC i BEL to właśnie to, co usuwamy.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

export class StreamLines {
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";

  /** Pełne linie z kawałka, jeszcze nieoczyszczone; reszta czeka na następny. */
  push(chunk: Buffer): string[] {
    const lines = (this.partial + this.decoder.write(chunk)).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL_CHARS) {
      lines.push(this.partial);
      this.partial = "";
    }
    return lines;
  }

  /** Niedokończona linia bez zabierania jej (np. do ostatnich linii stanu, zanim strumień się skończy). */
  pending(): string {
    return this.partial;
  }

  /** Koniec strumienia: niedokończona linia staje się ostatnią. */
  end(): string | undefined {
    const last = this.partial + this.decoder.end();
    this.partial = "";
    return last === "" ? undefined : last;
  }
}

/** Linia bez sekwencji ANSI; `\r` jest zostawiane, bo maskowanie musi widzieć całą linię (`visibleText`). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, "");
}

/** Postęp z `\r` nadpisuje linię w terminalu, więc widać to, co po ostatnim `\r`. */
export function visibleText(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\r") + 1).trimEnd();
}

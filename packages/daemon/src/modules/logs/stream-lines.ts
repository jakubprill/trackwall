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
  private readonly secrets: readonly string[];
  private partial = "";

  /**
   * Maskowanie działa na liniach, więc wymuszony podział linii nie może rozciąć sekretu (`secrets`): część przed
   * podziałem pokazałaby jego początek.
   */
  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
  }

  /** Pełne linie z kawałka, jeszcze nieoczyszczone; reszta czeka na następny. */
  push(chunk: Buffer): string[] {
    const lines = (this.partial + this.decoder.write(chunk)).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL_CHARS) {
      const cut = safeCut(this.partial, this.secrets);
      lines.push(this.partial.slice(0, cut));
      this.partial = this.partial.slice(cut);
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

/**
 * Miejsce wymuszonego podziału: koniec tekstu bez najdłuższego sekretu bez jednego znaku (sekret, który dopiero
 * przychodzi, zaczyna się w tej zakładce), cofnięty przed każdy sekret, który by go przecinał.
 */
function safeCut(text: string, secrets: readonly string[]): number {
  let cut = text.length - Math.max(0, ...secrets.map((s) => s.length - 1));
  for (let moved = true; moved; ) {
    moved = false;
    for (const secret of secrets) {
      const at = text.lastIndexOf(secret, cut - 1);
      if (at !== -1 && at < cut && at + secret.length > cut) {
        cut = at;
        moved = true;
      }
    }
  }
  // Tekst w całości z zachodzących na siebie sekretów: lepiej podzielić na końcu niż trzymać rosnącą linię.
  return cut > 0 ? cut : text.length;
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

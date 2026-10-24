import { closeSync, openSync, writeSync } from "node:fs";
import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * Nagranie sesji w formacie asciicast v2 (§4.4): nagłówek JSON, potem po linii `[sekundy, kod, dane]`.
 * Zapisywane jest wyjście (`o`), zmiana rozmiaru (`r`) i znaczniki (`m`) z rekordami hooków, żeby jedno
 * nagranie wystarczyło do odtworzenia wykrywania stanu. Wejście z klawiatury (`i`) nie jest zapisywane,
 * bo może zawierać hasła wpisane w sesji.
 */

const AsciicastHeader = z.looseObject({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Początek nagrania, sekundy od epoki; od niego liczy się czas zmian stanu przy odtwarzaniu. */
  timestamp: z.number(),
});
type AsciicastHeader = z.infer<typeof AsciicastHeader>;

export const AsciicastEvent = z.tuple([z.number().nonnegative(), z.enum(["o", "i", "r", "m"]), z.string()]);
export type AsciicastEvent = z.infer<typeof AsciicastEvent>;

export interface Asciicast {
  header: AsciicastHeader;
  events: AsciicastEvent[];
}

export function parseAsciicast(text: string): Asciicast {
  const [first, ...rest] = text.split("\n").filter((line) => line.trim() !== "");
  if (first === undefined) throw new Error("empty asciicast recording");
  return { header: parseLine(HeaderLine, first, 1), events: rest.map((line, i) => parseLine(EventLine, line, i + 2)) };
}

/**
 * Czas zdarzenia w ms od epoki. Writer zapisuje pełne ms jako sekundy od pełnej sekundy nagłówka, a sekundy jako
 * liczba zmiennoprzecinkowa nie zawsze mają dokładny zapis (1.005 * 1000 to 1004.999…), więc zaokrąglenie wraca
 * do zapisanej milisekundy.
 */
export function eventTimeMs(header: AsciicastHeader, seconds: number): number {
  return header.timestamp * 1000 + Math.round(seconds * 1000);
}

const HeaderLine = jsonOf(AsciicastHeader);
const EventLine = jsonOf(AsciicastEvent);

function parseLine<T extends z.ZodType>(schema: T, line: string, number: number): z.infer<T> {
  const parsed = schema.safeParse(line);
  if (!parsed.success) throw new Error(`bad recording line ${number}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface AsciicastWriterOptions {
  width: number;
  height: number;
}

export class AsciicastWriter {
  readonly #fd: number;
  /** `performance.now()` w chwili odpowiadającej pełnej sekundzie z nagłówka. */
  readonly #origin: number;
  readonly #startedAt: number;

  /**
   * Nagłówek ma tylko pełne sekundy, więc czasy zdarzeń liczą się od tej pełnej sekundy, a nie od chwili startu:
   * inaczej odtworzone czasy byłyby przesunięte o ułamek sekundy. Zegar monotoniczny, bo cofnięcie zegara
   * systemu (NTP po uśpieniu) dałoby ujemne czasy i nagranie, którego nie da się odczytać.
   */
  constructor(path: string, o: AsciicastWriterOptions) {
    this.#fd = openSync(path, "w");
    const wall = Date.now();
    this.#origin = performance.now() - (wall % 1000);
    this.#startedAt = Math.floor(wall / 1000) * 1000;
    const header: AsciicastHeader = { version: 2, width: o.width, height: o.height, timestamp: Math.floor(wall / 1000) };
    writeSync(this.#fd, `${JSON.stringify(header)}\n`);
  }

  /** Pełna sekunda z nagłówka, ms od epoki: od niej odtwarzanie liczy czasy zdarzeń. */
  get startedAt(): number {
    return this.#startedAt;
  }

  /**
   * Czas nagrania w pełnych ms od epoki. Zegar monotoniczny zamiast `Date.now`, żeby uśpienie komputera albo korekta
   * zegara nie dały innego stanu na żywo i z nagrania; pełne ms, bo tyle ma czas zmiany stanu.
   */
  now(): number {
    return this.#startedAt + Math.round(performance.now() - this.#origin);
  }

  /** Zapis zdarzenia zwraca jego czas w nagraniu: z tego czasu liczy stan i sesja na żywo, i odtwarzanie. */
  output(data: string): number {
    return this.#event("o", data);
  }

  resize(width: number, height: number): number {
    return this.#event("r", `${width}x${height}`);
  }

  marker(label: string): number {
    return this.#event("m", label);
  }

  close(): void {
    closeSync(this.#fd);
  }

  #event(code: AsciicastEvent[1], data: string): number {
    const at = this.now();
    const event: AsciicastEvent = [(at - this.#startedAt) / 1000, code, data];
    writeSync(this.#fd, `${JSON.stringify(event)}\n`);
    return at;
  }
}

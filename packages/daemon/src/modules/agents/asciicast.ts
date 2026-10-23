import { closeSync, openSync, writeSync } from "node:fs";
import { z } from "zod";

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
  timestamp: z.number().optional(),
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
  if (first === undefined) throw new Error("puste nagranie asciicast");
  const header = AsciicastHeader.parse(JSON.parse(first));
  const events = rest.map((line, i) => {
    const event = AsciicastEvent.safeParse(JSON.parse(line));
    if (!event.success) throw new Error(`zła linia ${i + 2} nagrania: ${z.prettifyError(event.error)}`);
    return event.data;
  });
  return { header, events };
}

export interface AsciicastWriterOptions {
  width: number;
  height: number;
  now: () => number;
}

export class AsciicastWriter {
  readonly #fd: number;
  readonly #now: () => number;
  readonly #startedAt: number;

  constructor(path: string, o: AsciicastWriterOptions) {
    this.#fd = openSync(path, "w");
    this.#now = o.now;
    this.#startedAt = o.now();
    const header: AsciicastHeader = { version: 2, width: o.width, height: o.height, timestamp: Math.floor(this.#startedAt / 1000) };
    writeSync(this.#fd, `${JSON.stringify(header)}\n`);
  }

  output(data: string): void {
    this.#event("o", data);
  }

  resize(width: number, height: number): void {
    this.#event("r", `${width}x${height}`);
  }

  marker(label: string): void {
    this.#event("m", label);
  }

  close(): void {
    closeSync(this.#fd);
  }

  #event(code: AsciicastEvent[1], data: string): void {
    const event: AsciicastEvent = [(this.#now() - this.#startedAt) / 1000, code, data];
    writeSync(this.#fd, `${JSON.stringify(event)}\n`);
  }
}

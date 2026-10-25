import { closeSync, openSync, writeSync } from "node:fs";
import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * A session recording in the asciicast v2 format (§4.4): a JSON header, then one `[seconds, code, data]` per line. The
 * output (`o`), resizes (`r`) and markers (`m`) with hook records and the kind of session key are written, so that one
 * recording is enough to replay the state detection. Keyboard input (`i`) is not written, because it may contain
 * passwords typed in the session.
 */

const AsciicastHeader = z.looseObject({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The start of the recording, seconds since the epoch; state change times are counted from it when replaying. */
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
 * The event time in ms since the epoch. The writer stores whole ms as seconds from the header's whole second, and seconds
 * as a floating-point number do not always have an exact representation (1.005 * 1000 is 1004.999…), so rounding brings
 * back the stored millisecond.
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
  /** `performance.now()` at the moment matching the header's whole second. */
  readonly #origin: number;
  readonly #startedAt: number;

  /**
   * The header has only whole seconds, so event times count from that whole second, not from the moment of the start:
   * otherwise replayed times would be shifted by a fraction of a second. A monotonic clock, because the system clock going
   * back (NTP after sleep) would give negative times and a recording that cannot be read.
   */
  constructor(path: string, o: AsciicastWriterOptions) {
    this.#fd = openSync(path, "w");
    const wall = Date.now();
    this.#origin = performance.now() - (wall % 1000);
    this.#startedAt = Math.floor(wall / 1000) * 1000;
    const header: AsciicastHeader = { version: 2, width: o.width, height: o.height, timestamp: Math.floor(wall / 1000) };
    writeSync(this.#fd, `${JSON.stringify(header)}\n`);
  }

  /** The header's whole second, ms since the epoch: replay counts event times from it. */
  get startedAt(): number {
    return this.#startedAt;
  }

  /**
   * The recording time in whole ms since the epoch. A monotonic clock instead of `Date.now`, so that the computer sleeping
   * or a clock correction does not give a different state live and from the recording; whole ms, because that is what a
   * state change time has.
   */
  now(): number {
    return this.#startedAt + Math.round(performance.now() - this.#origin);
  }

  /** Writing an event returns its time in the recording: both the live session and the replay compute the state from that time. */
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

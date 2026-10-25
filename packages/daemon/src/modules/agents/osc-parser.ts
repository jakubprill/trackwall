/**
 * Picks OSC sequences (`ESC ] <code> ; <data>`, ended by BEL or `ESC \`) out of the PTY output stream (§4.4, the `osc`
 * state source). The stream arrives in chunks, so a sequence split between chunks is put together. The rest of the
 * output is skipped: the parser changes nothing in what goes to the terminal and the recording.
 */

export interface Osc {
  /** The number before the first `;`, e.g. `9` or `0`. */
  code: string;
  /** Everything after the first `;`, e.g. `4;3;0`; an empty string when the sequence has no `;`. */
  data: string;
}

const ESC = "\x1b";
const BEL = "\x07";
/** A longer sequence is garbage or something we do not read (e.g. an image in OSC 1337); we do not keep it in memory. */
const MAX_OSC_LENGTH = 4096;

export class OscParser {
  /** The content of a started sequence; `undefined` outside a sequence, `null` in a sequence that is too long and skipped to its end. */
  #body: string | null | undefined;
  /** The previous character was ESC (also at the end of the previous chunk). */
  #afterEsc = false;

  feed(chunk: string): Osc[] {
    const found: Osc[] = [];
    for (const ch of chunk) {
      const osc = this.#body === undefined ? this.#outside(ch) : this.#inside(ch);
      if (osc) found.push(osc);
    }
    return found;
  }

  #outside(ch: string): undefined {
    if (this.#afterEsc && ch === "]") this.#body = "";
    this.#afterEsc = ch === ESC;
    return undefined;
  }

  #inside(ch: string): Osc | undefined {
    if (this.#afterEsc) {
      // `ESC \` ends the sequence; any other character after ESC breaks it and is read as outside a sequence, right after
      // the ESC (so `ESC ]` starts the next one at once).
      if (ch === "\\") {
        this.#afterEsc = false;
        return this.#finish();
      }
      this.#body = undefined;
      return this.#outside(ch);
    }
    if (ch === BEL) return this.#finish();
    if (ch === ESC) {
      this.#afterEsc = true;
      return undefined;
    }
    if (typeof this.#body === "string") this.#body = this.#body.length < MAX_OSC_LENGTH ? this.#body + ch : null;
    return undefined;
  }

  #finish(): Osc | undefined {
    const body = this.#body;
    this.#body = undefined;
    if (typeof body !== "string") return undefined;
    const semicolon = body.indexOf(";");
    return semicolon < 0 ? { code: body, data: "" } : { code: body.slice(0, semicolon), data: body.slice(semicolon + 1) };
  }
}

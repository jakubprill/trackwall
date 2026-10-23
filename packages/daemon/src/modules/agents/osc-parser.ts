/**
 * Wyłuskuje sekwencje OSC (`ESC ] <kod> ; <dane>`, zakończone BEL albo `ESC \`) ze strumienia wyjścia PTY
 * (§4.4, źródło stanu `osc`). Strumień przychodzi w kawałkach, więc sekwencja przecięta między kawałkami jest
 * składana. Reszta wyjścia jest pomijana: parser niczego nie zmienia w tym, co trafia do terminala i nagrania.
 */

export interface Osc {
  /** Numer przed pierwszym `;`, np. `9` albo `0`. */
  code: string;
  /** Wszystko po pierwszym `;`, np. `4;3;0`; pusty napis, gdy sekwencja nie ma `;`. */
  data: string;
}

const ESC = "\x1b";
const BEL = "\x07";
/** Dłuższa sekwencja to śmieci albo coś, czego nie czytamy (np. obraz w OSC 1337); nie trzymamy jej w pamięci. */
const MAX_OSC_LENGTH = 4096;

export class OscParser {
  /** Treść rozpoczętej sekwencji; `undefined` poza sekwencją, `null` w sekwencji za długiej, pomijanej do końca. */
  #body: string | null | undefined;
  /** Poprzedni znak był ESC (także na końcu poprzedniego kawałka). */
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
      // `ESC \` kończy sekwencję; każdy inny znak po ESC ją przerywa i jest czytany jak poza sekwencją, zaraz po ESC
      // (więc `ESC ]` od razu zaczyna następną).
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

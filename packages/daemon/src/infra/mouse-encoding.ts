import type headless from "@xterm/headless";

/**
 * How the program in a session asks the terminal to encode mouse reports, which the screen image of
 * `@xterm/addon-serialize` leaves out: it restores the mouse tracking mode (1000, 1002, 1003) but not its encoding
 * (§4.4, ADR-26). Copilot CLI turns on SGR (1006), and a window that got the image without it encodes the mouse the X10
 * way, which xterm.js sends through `onBinary` instead of `onData`: the wheel, clicks and Copilot CLI's own selection
 * then never reach the program. The emulator does not expose the encoding, so it is followed here from the output, by
 * xterm.js's own rules, since xterm.js is what draws the window: DECSET 1006 is SGR, 1016 SGR in pixels, resetting either
 * goes back to the default, 1005 and 1015 are not supported and change nothing, and a terminal reset (RIS) clears it.
 */

type Parser = InstanceType<typeof headless.Terminal>["parser"];

/** The DECSET number of the encoding the window has to turn on, or `undefined` for the default. */
type MouseEncodingMode = 1006 | 1016 | undefined;

/** The encoding after one `CSI ? … h` (`set`) or `CSI ? … l` (`reset`) sequence with these parameters. */
function nextMouseEncoding(current: MouseEncodingMode, params: readonly (number | number[])[], change: "set" | "reset"): MouseEncodingMode {
  let mode = current;
  for (const param of params) {
    const number = Array.isArray(param) ? param[0] : param;
    if (number !== 1006 && number !== 1016) continue;
    mode = change === "set" ? number : undefined;
  }
  return mode;
}

export class MouseEncoding {
  #mode: MouseEncodingMode;

  /** Follows the sequences the emulator parses; each handler returns `false`, so the emulator still handles them itself. */
  constructor(parser: Parser) {
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      this.#mode = nextMouseEncoding(this.#mode, params, "set");
      return false;
    });
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      this.#mode = nextMouseEncoding(this.#mode, params, "reset");
      return false;
    });
    parser.registerEscHandler({ final: "c" }, () => {
      this.#mode = undefined;
      return false;
    });
  }

  /** The sequence that turns the encoding on in a window that gets the screen image, or "" for the default. */
  sequence(): string {
    return this.#mode === undefined ? "" : `\x1b[?${this.#mode}h`;
  }
}

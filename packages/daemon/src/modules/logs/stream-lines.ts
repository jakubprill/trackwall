import { StringDecoder } from "node:string_decoder";

/**
 * The bytes of one stream (stdout or stderr) as lines of text shown in the UI. Every stream has its own decoder
 * and unfinished line, so that a UTF-8 character or a line split between chunks does not mix with the other stream.
 */

/**
 * An unfinished line longer than this is emitted as a line: a progress bar without `\n` (only `\r`) would grow in memory
 * for the whole time the process runs.
 */
const MAX_PARTIAL_CHARS = 64 * 1024;

// CSI and OSC sequences: colour and window title mean nothing in text shown in the UI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC and BEL are exactly what we remove.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

export class StreamLines {
  private readonly decoder = new StringDecoder("utf8");
  private readonly secrets: readonly string[];
  private partial = "";

  /**
   * Masking works on lines, so a forced line split must not cut a secret (`secrets`): the part before
   * the split would show its beginning.
   */
  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
  }

  /** Full lines from a chunk, not yet cleaned; the rest waits for the next one. */
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

  /** The unfinished line without taking it (e.g. for the state's last lines, before the stream ends). */
  pending(): string {
    return this.partial;
  }

  /** The end of the stream: the unfinished line becomes the last one. */
  end(): string | undefined {
    const last = this.partial + this.decoder.end();
    this.partial = "";
    return last === "" ? undefined : last;
  }
}

/**
 * The place of a forced split: the end of the text minus the longest secret less one character (a secret that is only
 * arriving can start only in these last characters), moved back before any secret it would cut.
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
  // Not between the halves of a UTF-16 surrogate pair (an emoji): both parts would show a replacement character.
  const high = text.charCodeAt(cut - 1);
  if (high >= 0xd800 && high <= 0xdbff) cut -= 1;
  // Text made entirely of overlapping secrets: better to split at the end than keep a growing line.
  return cut > 0 ? cut : text.length;
}

/** A line without ANSI sequences; `\r` is kept, because masking must see the whole line (`visibleText`). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, "");
}

/** Progress with `\r` overwrites the line in the terminal, so what is after the last `\r` is what shows. */
export function visibleText(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\r") + 1).trimEnd();
}

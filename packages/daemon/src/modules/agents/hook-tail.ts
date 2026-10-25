import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { CopilotHookRecord } from "./copilot-hook-record.ts";
import { jsonOf } from "./json.ts";

/**
 * Reads the lines that hook processes append to the session's `hooks.jsonl` (ADR-17), from where it stopped last time.
 * A hook is a separate process Copilot CLI runs, so the file is the only channel to the daemon that does not require
 * giving the hook a token.
 */

const HookLine = jsonOf(CopilotHookRecord);

export class HookTail {
  readonly #fd: number;
  readonly #buffer = Buffer.alloc(64 * 1024);
  readonly #decoder = new StringDecoder("utf8");
  #offset = 0;
  #partial = "";

  constructor(path: string) {
    this.#fd = openSync(path, "r");
  }

  read(): CopilotHookRecord[] {
    if (fstatSync(this.#fd).size === this.#offset) return [];
    let text = this.#partial;
    let n = readSync(this.#fd, this.#buffer, 0, this.#buffer.length, this.#offset);
    while (n > 0) {
      this.#offset += n;
      text += this.#decoder.write(this.#buffer.subarray(0, n));
      n = readSync(this.#fd, this.#buffer, 0, this.#buffer.length, this.#offset);
    }
    const lines = text.split("\n");
    this.#partial = lines.pop() ?? "";
    // A line that is not a record (e.g. two hooks appended at once) is skipped: it only means a worse state.
    return lines.flatMap((line) => HookLine.safeParse(line).data ?? []);
  }

  close(): void {
    closeSync(this.#fd);
  }
}

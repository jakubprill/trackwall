import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { type CopilotHookEvent, CopilotHookRecord, hookRecord } from "./copilot-hook-record.ts";
import { jsonOf } from "./json.ts";

/**
 * The session's `hooks.jsonl` (ADR-17): `appendHookRecord` writes a hook's record, `HookTail` reads the lines from where
 * it stopped last time. The daemon writes the hooks Copilot CLI POSTs to it (ADR-88), the recording script those of its
 * own hook program; the file is also the session's log of hooks.
 */

/** Appends the hook record of a hook payload; a payload that is not a JSON object leaves no record. */
export function appendHookRecord(file: string, event: CopilotHookEvent, payload: string): void {
  const r = hookRecord(event, payload, Date.now());
  if (r) appendFileSync(file, `${JSON.stringify(r)}\n`);
}

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

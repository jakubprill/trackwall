import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { CopilotHookRecord } from "./copilot-hook-record.ts";
import { jsonOf } from "./json.ts";

/**
 * Czyta linie dopisywane do `hooks.jsonl` sesji przez procesy hooków (ADR-17), od miejsca, w którym skończył
 * poprzednio. Hook to osobny proces uruchamiany przez Copilot CLI, więc plik jest jedynym kanałem do daemona,
 * który nie wymaga podawania hookowi tokenu.
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
    // Linia, która nie jest rekordem (np. dwa hooki dopisały się naraz), jest pomijana: to tylko gorszy stan.
    return lines.flatMap((line) => HookLine.safeParse(line).data ?? []);
  }

  close(): void {
    closeSync(this.#fd);
  }
}

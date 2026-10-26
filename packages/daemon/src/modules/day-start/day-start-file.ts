import { readFileSync } from "node:fs";
import { CommitHash, DayReport } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * `day-start.json` in the state directory (ADR-70): the last day start, so the next one knows what "since last time"
 * means after a restart or an update. `heads` is the commit of each repo's remote default branch then; `report` is what
 * the supervisor read, so `get_day_report` returns the same report until the next day start.
 */

const DayStartState = z.object({
  /** ISO 8601. */
  startedAt: z.iso.datetime(),
  /** By repo root, as the sync joins its results (ADR-18). */
  heads: z.record(z.string(), CommitHash),
  report: DayReport,
});
export type DayStartState = z.infer<typeof DayStartState>;

export class DayStartFile {
  readonly #path: string;
  readonly #log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void) {
    this.#path = path;
    this.#log = log;
  }

  /**
   * The last day start; `null` without one. An unreadable file is logged and read as no day start: the next one then
   * reports nothing as new and writes a good file, which is all there is to lose.
   */
  read(): DayStartState | null {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.#log(`${this.#path}: not JSON; the next day start compares with nothing`);
      return null;
    }
    const parsed = DayStartState.safeParse(json);
    if (parsed.success) return parsed.data;
    this.#log(`${this.#path}: ${z.prettifyError(parsed.error)}; the next day start compares with nothing`);
    return null;
  }

  write(state: DayStartState): void {
    writeFileAtomic(this.#path, `${JSON.stringify(state, null, 2)}\n`);
  }
}

import { appendFileSync, readFileSync } from "node:fs";
import { EndedTask, TASK_HISTORY_MAX_CHARS, type TaskHistoryQuery, type TaskHistoryResult } from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { messageOf } from "../../infra/errors.ts";

/**
 * The task journal (§4.19, ADR-150): one JSON line per ended task in `task-journal.jsonl` of the state directory,
 * appended when the user ends a task, and searched by words for `search_task_history`. There is no index and no model:
 * a few thousand records are read and matched in milliseconds. The file keeps the newest `MAX_RECORDS`; a line that
 * does not parse (a hand edit, a cut write) is skipped, not fatal, so one bad line does not hide the rest.
 */

export const TASK_JOURNAL_FILE = "task-journal.jsonl";

/** The journal keeps this many records by default; the oldest go when a new one would pass it. */
const MAX_RECORDS = 2000;

export interface TaskJournalDeps {
  /** `task-journal.jsonl` in the state directory. */
  file: string;
  log: (msg: string) => void;
  /** `MAX_RECORDS` unless a test needs a small journal. */
  maxRecords?: number;
}

export class TaskJournal {
  readonly #deps: TaskJournalDeps;

  constructor(deps: TaskJournalDeps) {
    this.#deps = deps;
  }

  /** Adds the record of an ended task; a failed write goes to the log, because the task has ended either way. */
  record(task: EndedTask): void {
    try {
      const max = this.#deps.maxRecords ?? MAX_RECORDS;
      const lines = this.#lines();
      const line = JSON.stringify(task);
      if (lines.length < max) appendFileSync(this.#deps.file, `${line}\n`);
      else writeFileAtomic(this.#deps.file, `${[...lines.slice(lines.length - max + 1), line].join("\n")}\n`);
    } catch (err) {
      this.#deps.log(`writing ended task ${task.task} to the task journal: ${messageOf(err)}`);
    }
  }

  /** The records that match `query`, newest ended first, within its limit and `TASK_HISTORY_MAX_CHARS`. */
  search(query: TaskHistoryQuery): TaskHistoryResult {
    const words = query.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "");
    const since = query.since === undefined ? null : Date.parse(`${query.since}T00:00:00Z`);
    const matching = this.#records()
      .filter((r) => query.repos.length === 0 || query.repos.includes(r.repo))
      .filter((r) => since === null || Date.parse(r.endedAt) >= since)
      .map((record) => ({ record, text: searchedText(record) }))
      .filter(({ text }) => words.every((w) => text.includes(w)))
      .sort((a, b) => Date.parse(b.record.endedAt) - Date.parse(a.record.endedAt));
    const tasks: EndedTask[] = [];
    let chars = 0;
    for (const { record, text } of matching) {
      chars += text.length;
      if (tasks.length >= query.limit || chars > TASK_HISTORY_MAX_CHARS) break;
      tasks.push(record);
    }
    return { tasks, truncated: tasks.length < matching.length };
  }

  #records(): EndedTask[] {
    return this.#lines().flatMap((line) => {
      try {
        const parsed = EndedTask.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /** The file's non-empty lines; none before the first ended task. */
  #lines(): string[] {
    let text: string;
    try {
      text = readFileSync(this.#deps.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text.split("\n").filter((line) => line.trim() !== "");
  }
}

/** What the words of a query are looked for in, lower-cased. */
function searchedText(r: EndedTask): string {
  return [r.repo, r.branch, r.title ?? "", r.prompt, r.summary ?? "", ...r.commits.map((c) => c.subject), ...r.files]
    .join("\n")
    .toLowerCase();
}

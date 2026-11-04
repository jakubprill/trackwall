import { appendFileSync, readFileSync } from "node:fs";
import { EndedTask, TASK_HISTORY_MAX_CHARS, type TaskHistoryQuery, type TaskHistoryResult } from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { messageOf } from "../../infra/errors.ts";

/**
 * The task journal (§4.19, ADR-150): one JSON line per ended task in `task-journal.jsonl` of the state directory,
 * appended when the user ends a task, and searched by words for `search_task_history`. There is no index and no model:
 * a few thousand records are read and matched in milliseconds. The file keeps the newest `TASK_JOURNAL_MAX_RECORDS`; a line that
 * does not parse (a hand edit, a cut write) is skipped, not fatal, so one bad line does not hide the rest.
 */

export const TASK_JOURNAL_FILE = "task-journal.jsonl";

/** The journal keeps this many records; the oldest go once it passes them by `TRIM_SLACK`. */
export const TASK_JOURNAL_MAX_RECORDS = 2000;
/** Records over the limit before the file is rewritten, so that a full journal is not rewritten at every end. */
const TRIM_SLACK = 0.1;

export interface TaskJournalDeps {
  /** `task-journal.jsonl` in the state directory. */
  file: string;
  log: (msg: string) => void;
  maxRecords: number;
  /**
   * What replaces the values of the user's secrets in text, as in the logs (a prompt or a summary may hold one); asked
   * at every record, because the user's environment can change while the daemon works.
   */
  masker: () => Promise<(text: string) => string>;
}

export class TaskJournal {
  readonly #deps: TaskJournalDeps;

  constructor(deps: TaskJournalDeps) {
    this.#deps = deps;
  }

  /** The number of lines in the file, counted at the first record and followed after it. */
  #count: number | null = null;

  /**
   * Adds the record of an ended task, with secrets masked in its texts; a failed write goes to the log, because the
   * task has ended either way.
   */
  async record(task: EndedTask): Promise<void> {
    try {
      const mask = await this.#deps.masker();
      const masked: EndedTask = {
        ...task,
        prompt: mask(task.prompt),
        summary: task.summary === null ? null : mask(task.summary),
        commits: task.commits.map((c) => ({ ...c, subject: mask(c.subject) })),
      };
      const line = JSON.stringify(masked);
      this.#count ??= this.#lines().length;
      const max = this.#deps.maxRecords;
      if (this.#count < Math.floor(max * (1 + TRIM_SLACK))) {
        appendFileSync(this.#deps.file, `${line}\n`);
        this.#count++;
        return;
      }
      const kept = [...this.#lines().slice(-(max - 1)), line];
      writeFileAtomic(this.#deps.file, `${kept.join("\n")}\n`);
      this.#count = kept.length;
    } catch (err) {
      this.#count = null;
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
    const matching = this.records()
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

  /** Every record, oldest ended first; a line that does not parse is skipped. */
  records(): EndedTask[] {
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

import { readFileSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Task } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { TaskBranch } from "./task-branch.ts";

/**
 * `tasks.json` w katalogu stanu (ADR-31): zadania przeżywają restart daemona, bo ich worktree i gałęzie zostają
 * na dysku, dopóki użytkownik ich nie zakończy. Sesja zadania żyje tylko w pamięci, a worktree wynika z repo i gałęzi
 * (`taskWorktree`), więc żadne z nich nie jest zapisywane. Plik można zmienić ręcznie, a jego pola trafiają do gita
 * (`branch -D`, `diff <commit bazowy>`), więc schemat dopuszcza tylko gałąź zadania i pełny hash commita (`CommitHash` w `Task`).
 * Fields added later (title, origin and summary, ADR-39; the trusted mise config, ADR-59) have a default in the file,
 * so tasks saved by an older version are not moved aside as an unreadable file.
 */

export const StoredTask = Task.omit({ worktree: true }).extend({
  branch: TaskBranch,
  title: Task.shape.title.default(null),
  proposedBy: Task.shape.proposedBy.default(null),
  summary: Task.shape.summary.default(null),
  /**
   * The worktree's mise config the user trusted (ADR-59): path to SHA-256, taken when the worktree was created and
   * replaced when the user trusts a changed one. `null` in a task saved by an older version, whose config then needs
   * the user's trust once.
   */
  trustedMiseConfig: z
    .record(z.string().max(1024), z.string().regex(/^[0-9a-f]{64}$/))
    .nullable()
    .default(null),
  /** Korzeń repo z folderu z projektami, z którego wyszło zadanie: tam git trzyma rejestr worktree i gałąź. */
  repoDir: z.string().refine(isAbsolute, "repo root must be a full path"),
});
export type StoredTask = z.infer<typeof StoredTask>;

const TaskFileSchema = z.object({ tasks: z.array(StoredTask) });

export class TaskFile {
  readonly #path: string;
  readonly #log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void) {
    this.#path = path;
    this.#log = log;
  }

  /** Brak pliku to brak zadań. Plik nieczytelny trafia obok (`tasks.json.broken-<czas>`), a jego zadania do logu. */
  read(): StoredTask[] {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const parsed = parse(text);
    if (typeof parsed !== "string") return parsed;
    const aside = `${this.#path}.broken-${Date.now()}`;
    renameSync(this.#path, aside);
    this.#log(`${this.#path}: ${parsed}; file moved to ${aside}, task worktrees were left on disk`);
    return [];
  }

  write(tasks: readonly StoredTask[]): void {
    writeFileAtomic(this.#path, `${JSON.stringify({ tasks }, null, 2)}\n`);
  }
}

/** Zadania z pliku albo opis, co z nim nie tak. */
function parse(text: string): StoredTask[] | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  const parsed = TaskFileSchema.safeParse(json);
  return parsed.success ? parsed.data.tasks : z.prettifyError(parsed.error);
}

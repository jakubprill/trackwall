import { readFileSync, renameSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { Task } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-write.ts";

/**
 * `tasks.json` w katalogu stanu (ADR-31): zadania przeżywają restart daemona, bo ich worktree i gałęzie zostają
 * na dysku, dopóki użytkownik ich nie usunie. Sesja zadania żyje tylko w pamięci, więc nie jest zapisywana.
 * Plik leży u użytkownika i może być zmieniony ręcznie, a usunięcie zadania kasuje katalog z `--force`, więc
 * worktree spoza katalogu worktree daemona nie przechodzi odczytu.
 */

export const StoredTask = Task.omit({ session: true }).extend({
  /** Korzeń repo z folderu z projektami, z którego wyszło zadanie: tam git trzyma rejestr worktree i gałąź. */
  repoDir: z.string(),
});
export type StoredTask = z.infer<typeof StoredTask>;

const TaskFileSchema = z.object({ tasks: z.array(StoredTask) });

export class TaskFile {
  readonly #path: string;
  readonly #worktreesDir: string;
  readonly #log: (msg: string) => void;

  constructor(path: string, worktreesDir: string, log: (msg: string) => void) {
    this.#path = path;
    this.#worktreesDir = worktreesDir;
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
    const parsed = this.#parse(text);
    if (typeof parsed !== "string") return parsed;
    const aside = `${this.#path}.broken-${Date.now()}`;
    renameSync(this.#path, aside);
    this.#log(`${this.#path}: ${parsed}; plik przeniesiony do ${aside}, worktree zadań zostały na dysku`);
    return [];
  }

  write(tasks: readonly StoredTask[]): void {
    writeFileAtomic(this.#path, `${JSON.stringify({ tasks }, null, 2)}\n`);
  }

  /** Zadania z pliku albo opis, co z nim nie tak. */
  #parse(text: string): StoredTask[] | string {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return "to nie jest JSON";
    }
    const parsed = TaskFileSchema.safeParse(json);
    if (!parsed.success) return z.prettifyError(parsed.error);
    const outside = parsed.data.tasks.find((t) => !isAbsolute(t.repoDir) || !isInside(this.#worktreesDir, t.worktree));
    return outside ? `worktree zadania ${outside.id} (${outside.worktree}) leży poza ${this.#worktreesDir}` : parsed.data.tasks;
  }
}

/** `path` leży wewnątrz `dir` (nie jest nim samym); bez dowiązań, bo worktree tworzy daemon. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

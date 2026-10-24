/**
 * Nazwa gałęzi i katalogu worktree zadania (ADR-31) z polecenia: kilka pierwszych słów bez polskich znaków, małymi
 * literami, z łącznikami, i początek identyfikatora zadania, żeby dwa zadania z tym samym poleceniem się nie zderzyły.
 * Tylko `[a-z0-9-]`, więc nazwa jest poprawną gałęzią gita i katalogiem na Windowsie i macOS bez cytowania.
 */

import { join } from "node:path";
import { z } from "zod";

/** Bez znaków specjalnych wyrażeń regularnych, bo trafia do `TaskBranch` dosłownie. */
export const TASK_BRANCH_PREFIX = "trackwall/";

/**
 * Gałąź zadania; w `tasks.json` tylko taka, bo daemon usuwa ją z `branch -D` i robi z niej katalog worktree, a plik
 * można zmienić ręcznie. Znaki to te, które daje `taskSlug`.
 */
export const TaskBranch = z
  .string()
  .regex(new RegExp(`^${TASK_BRANCH_PREFIX}[a-z0-9][a-z0-9-]*$`), `gałąź zadania: ${TASK_BRANCH_PREFIX} i [a-z0-9-]`);
/** Krótko: katalog worktree leży w katalogu stanu, a Windows ma limit 260 znaków na całą ścieżkę pliku w repo. */
const SLUG_MAX = 32;
const ID_CHARS = 6;

/** Litery, których NFD nie rozkłada na literę bazową i znak diakrytyczny. */
const UNDECOMPOSED: Record<string, string> = { ł: "l", ø: "o", ß: "ss", æ: "ae", œ: "oe", đ: "d" };

/** Ostatni segment gałęzi zadania i zarazem nazwa katalogu jego worktree, np. `napraw-logowanie-3f2a9c`. */
export function taskSlug(prompt: string, taskId: string): string {
  const words = prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøßæœđ]/g, (c) => UNDECOMPOSED[c] ?? c)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // Pierwsze słowo dłuższe niż limit ucina się zamiast znikać.
  if (slug === "" && words[0]) slug = words[0].slice(0, SLUG_MAX);
  const suffix = taskId.replaceAll("-", "").slice(0, ID_CHARS);
  return slug === "" ? `zadanie-${suffix}` : `${slug}-${suffix}`;
}

/**
 * Worktree zadania: `<katalog worktree>/<repo>/<gałąź bez prefiksu>`. Liczony, a nie zapisywany, więc z `tasks.json`
 * nie da się wskazać katalogu poza katalogiem worktree (identyfikator repo i gałąź nie mają separatorów ścieżki).
 */
export function taskWorktree(worktreesDir: string, repo: string, branch: string): string {
  return join(worktreesDir, repo, branch.slice(TASK_BRANCH_PREFIX.length));
}

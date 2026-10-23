/**
 * Nazwa gałęzi i katalogu worktree zadania (ADR-31) z polecenia: kilka pierwszych słów bez polskich znaków, małymi
 * literami, z łącznikami, i początek identyfikatora zadania, żeby dwa zadania z tym samym poleceniem się nie zderzyły.
 * Tylko `[a-z0-9-]`, więc nazwa jest poprawną gałęzią gita i katalogiem na Windowsie i macOS bez cytowania.
 */

export const TASK_BRANCH_PREFIX = "trackwall/";
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

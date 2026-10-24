import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TaskChanges } from "@trackwall/protocol";
import { git } from "./git.ts";
import { parseChangedFiles } from "./parse.ts";
import { commitCount, uncommittedCount } from "./worktree.ts";

/**
 * Zmiany worktree zadania (ADR-31): katalog roboczy względem commita bazowego, z nowymi plikami i bez ignorowanych.
 * Nowe pliki trafiają do indeksu tymczasowego (kopia indeksu worktree, żeby git nie liczył od nowa niezmienionych
 * plików) tylko jako zamiar dodania (`--intent-to-add`), więc indeks agenta zostaje nietknięty, a odpytywanie co
 * kilka sekund nie zapisuje do `.git/objects` nowej wersji każdego zmienionego pliku. Diff bez zewnętrznych programów
 * diff i `textconv` z konfiguracji repo.
 */

/** Duże worktree na Windowsie ze skanującym antywirusem potrafią liczyć `git status` kilkanaście sekund. */
const CHANGES_TIMEOUT_MS = 60_000;

export async function worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<TaskChanges> {
  const index = resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).stdout.toString("utf8").trim());
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyFile(index, tmp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    // Git kończy się kodem 1, gdy któregoś pliku nie przeczyta (trzymany przez proces na Windowsie), choć pozostałe
    // dodał; diff bez tego jednego nowego pliku jest lepszy niż żaden.
    await git(dir, ["add", "--intent-to-add", "--all", "--ignore-errors", "--", "."], {
      indexFile: tmp,
      timeoutMs: CHANGES_TIMEOUT_MS,
    }).catch(() => {});
    const diff = (args: string[], maxBytes?: number) =>
      git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", ...args, base, "--"], {
        indexFile: tmp,
        timeoutMs: CHANGES_TIMEOUT_MS,
        maxBytes,
      });
    // Wszystkie naraz, ale do końca każdej: indeks tymczasowy można usunąć dopiero, gdy żaden git go nie czyta.
    const work = [
      diff(["--name-status", "-z"]),
      diff(["--numstat", "-z"]),
      diff([], maxPatchBytes),
      commitCount(dir, base, "HEAD"),
      uncommittedCount(dir),
    ] as const;
    await Promise.allSettled(work);
    const [names, stats, patch, commits, uncommitted] = await Promise.all(work);
    return {
      files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")),
      patch: patch.stdout.toString("utf8"),
      truncated: patch.truncated,
      commits,
      uncommitted,
    };
  } finally {
    // Pozostałość po gicie zabitym po limicie czasu; plik w katalogu tymczasowym nie jest wart przykrycia błędu.
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

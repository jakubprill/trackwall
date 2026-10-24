import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TaskChanges, WorkingTreeChanges } from "@trackwall/protocol";
import { git } from "./git.ts";
import { parseChangedFiles } from "./parse.ts";
import { ExitCodeError, type RunOutput } from "./run.ts";
import { commitCount, uncommittedCount } from "./worktree.ts";

/**
 * Zmiany katalogu roboczego względem commita, z nowymi plikami i bez ignorowanych: worktree zadania względem commita
 * bazowego (ADR-31) i repo z folderu z projektami względem HEAD (ADR-34). Nowe pliki trafiają do indeksu tymczasowego
 * (kopia indeksu katalogu roboczego, żeby git nie liczył od nowa niezmienionych plików) tylko jako zamiar dodania
 * (`--intent-to-add`), więc indeks agenta i użytkownika zostaje nietknięty, a odpytywanie co kilka sekund nie zapisuje
 * do `.git/objects` nowej wersji każdego zmienionego pliku. Diff bez zewnętrznych programów diff i `textconv`
 * z konfiguracji repo.
 */

/** Duże worktree na Windowsie ze skanującym antywirusem potrafią liczyć `git status` kilkanaście sekund. */
const CHANGES_TIMEOUT_MS = 60_000;

/** Bez diffu: same pliki z liczbą linii i liczby commitów (narzędzie MCP `get_session`). */
const NO_PATCH: RunOutput = { stdout: Buffer.alloc(0), truncated: false };

/**
 * Zmiany worktree zadania razem z liczbą commitów zadania i niezacommitowanych plików. `maxPatchBytes` 0 pomija diff:
 * git nie liczy treści zmian, a `patch` jest pusty.
 */
export async function worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<TaskChanges> {
  // Do końca każdej: zakończenie zadania czeka na ten odczyt, zanim skasuje worktree, więc odrzucenie jednej części
  // nie może zostawić gita, który nadal czyta katalog.
  const work = [workingTreeChanges(dir, base, maxPatchBytes), commitCount(dir, base, "HEAD"), uncommittedCount(dir)] as const;
  await Promise.allSettled(work);
  const [changes, commits, uncommitted] = await Promise.all(work);
  return { ...changes, commits, uncommitted };
}

/** Katalog roboczy `dir` względem `base` (commit albo drzewo). */
export async function workingTreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<WorkingTreeChanges> {
  const index = resolve(dir, (await git(dir, ["rev-parse", "--git-path", "index"])).stdout.toString("utf8").trim());
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyFile(index, tmp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    // Z `--ignore-errors` git kończy się kodem 1, gdy któregoś pliku nie przeczyta (trzymany przez proces na Windowsie),
    // choć pozostałe dodał; diff bez tego jednego nowego pliku jest lepszy niż żaden. Każdy inny błąd jest błędem.
    await git(dir, ["add", "--intent-to-add", "--all", "--ignore-errors", "--", "."], {
      indexFile: tmp,
      timeoutMs: CHANGES_TIMEOUT_MS,
    }).catch((err: unknown) => {
      if (!(err instanceof ExitCodeError && err.exitCode === 1)) throw err;
    });
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
      maxPatchBytes > 0 ? diff([], maxPatchBytes) : Promise.resolve(NO_PATCH),
    ] as const;
    await Promise.allSettled(work);
    const [names, stats, patch] = await Promise.all(work);
    return {
      // Ostatni wpis uciętej listy może mieć niepełną ścieżkę.
      files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")).slice(0, names.truncated ? -1 : undefined),
      patch: patch.stdout.toString("utf8"),
      // Ucięta lista plików (dziesiątki tysięcy nowych plików bez `.gitignore`) też jest niepełnym wynikiem.
      truncated: patch.truncated || names.truncated || stats.truncated,
    };
  } finally {
    // Pozostałość po gicie zabitym po limicie czasu; plik w katalogu tymczasowym nie jest wart przykrycia błędu.
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

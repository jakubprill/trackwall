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
 * plików) wpisem z hashem pustego bloba, tak jak przy `git add --intent-to-add`, ale bez zapisu tego bloba do
 * `.git/objects`. Liczenie zmian niczego więc nie zapisuje do repo: indeks agenta zostaje nietknięty, a kilka okien
 * naraz nie pisze tego samego obiektu, co na Windowsie kończyło się „Permission denied” (#36). Diff bez zewnętrznych
 * programów diff i `textconv` z konfiguracji repo.
 */

/** Hash pustego bloba w obu formatach obiektów gita (`git hash-object -t blob /dev/null`). */
const EMPTY_BLOB: Record<string, string> = {
  sha1: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  sha256: "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
};

/** Duże worktree na Windowsie ze skanującym antywirusem potrafią liczyć `git status` kilkanaście sekund. */
const CHANGES_TIMEOUT_MS = 60_000;

export async function worktreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<TaskChanges> {
  const [indexPath = "", objectFormat = ""] = (await git(dir, ["rev-parse", "--git-path", "index", "--show-object-format"])).stdout
    .toString("utf8")
    .split("\n");
  const emptyBlob = EMPTY_BLOB[objectFormat];
  if (emptyBlob === undefined) throw new Error(`unknown git object format "${objectFormat}"`);
  const index = resolve(dir, indexPath);
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyFile(index, tmp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    const untrackedTruncated = await addUntracked(dir, tmp, emptyBlob);
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
      truncated: patch.truncated || untrackedTruncated,
      commits,
      uncommitted,
    };
  } finally {
    // Pozostałość po gicie zabitym po limicie czasu; plik w katalogu tymczasowym nie jest wart przykrycia błędu.
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

/**
 * Nowe pliki katalogu roboczego (bez ignorowanych) jako wpisy indeksu `index` z hashem pustego bloba: `diff` z katalogiem
 * roboczym i tak czyta ich treść z dysku, a `update-index --index-info`, w przeciwieństwie do `add --intent-to-add`,
 * nie zapisuje bloba do `.git/objects`. Katalog z własnym repo `ls-files` podaje z `/` na końcu; to wpis submodułu,
 * którego hash też nie jest czytany, bo diff bierze HEAD tamtego repo. Zwraca, czy lista nowych plików była ucięta.
 */
async function addUntracked(dir: string, index: string, emptyBlob: string): Promise<boolean> {
  const listed = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"], {
    indexFile: index,
    timeoutMs: CHANGES_TIMEOUT_MS,
  });
  const paths = listed.stdout.toString("utf8").split("\0");
  // Ostatni kawałek to pusty napis po końcowym NUL albo niepełna ścieżka uciętej listy.
  paths.pop();
  if (paths.length === 0) return listed.truncated;
  const entries = paths.map((path) => (path.endsWith("/") ? `160000 ${emptyBlob}\t${path.slice(0, -1)}` : `100644 ${emptyBlob}\t${path}`));
  await git(dir, ["update-index", "-z", "--index-info"], {
    indexFile: index,
    stdin: `${entries.join("\0")}\0`,
    timeoutMs: CHANGES_TIMEOUT_MS,
  });
  return listed.truncated;
}

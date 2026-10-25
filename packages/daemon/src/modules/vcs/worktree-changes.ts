import { randomUUID } from "node:crypto";
import { copyFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TaskChanges, WorkingTreeChanges } from "@trackwall/protocol";
import { mapLimit } from "../../infra/map-limit.ts";
import { git, revParse } from "./git.ts";
import { parseChangedFiles, parseNulTerminated } from "./parse.ts";
import type { RunOutput } from "./run.ts";
import { commitCount, uncommittedCount } from "./worktree.ts";

/**
 * Zmiany katalogu roboczego względem commita, z nowymi plikami i bez ignorowanych: worktree zadania względem commita
 * bazowego (ADR-31) i repo z folderu z projektami względem HEAD (ADR-34). Nowe pliki trafiają do indeksu tymczasowego
 * (kopia indeksu katalogu roboczego, żeby git nie liczył od nowa niezmienionych plików) wpisem z hashem pustego bloba,
 * tak jak przy `git add --intent-to-add`, ale bez zapisu tego bloba do `.git/objects`. Liczenie zmian niczego więc nie
 * zapisuje do repo: indeks agenta i użytkownika zostaje nietknięty, a kilka okien naraz nie pisze tego samego obiektu,
 * co na Windowsie kończyło się „Permission denied” (#36). Diff bez zewnętrznych programów diff i `textconv`
 * z konfiguracji repo.
 */

/** Hash pustego bloba w obu formatach obiektów gita (`git hash-object -t blob /dev/null`). */
const EMPTY_BLOB = new Map([
  ["sha1", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
  ["sha256", "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"],
]);

const NUL = Buffer.from([0]);
const SLASH = "/".charCodeAt(0);

/** Osadzone repo to po jednym `git rev-parse`; procesy na Windowsie są drogie w starcie i skanowane przez antywirus. */
const SUBMODULE_CONCURRENCY = 4;

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

/**
 * A copy of the index with the original's modification time. Git trusts a file's size and time in the index only if
 * the file is older than the index file ("racy git"); a copy written now would make a file changed to the same size
 * right after checkout look unchanged. A missing index (repo without commits) gives no copy.
 */
async function copyIndex(index: string, copy: string): Promise<void> {
  try {
    const { atime, mtime } = await stat(index);
    await copyFile(index, copy);
    await utimes(copy, atime, mtime);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Katalog roboczy `dir` względem `base` (commit albo drzewo). */
export async function workingTreeChanges(dir: string, base: string, maxPatchBytes: number): Promise<WorkingTreeChanges> {
  const out = (await git(dir, ["rev-parse", "--git-path", "index", "--show-object-format"])).stdout.toString("utf8").trim();
  const [indexPath, objectFormat] = out.split(/\r?\n/);
  const emptyBlob = objectFormat === undefined ? undefined : EMPTY_BLOB.get(objectFormat);
  if (!indexPath || emptyBlob === undefined) throw new Error(`git rev-parse did not give the index path and a known object format: ${out}`);
  const index = resolve(dir, indexPath);
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyIndex(index, tmp);
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
      maxPatchBytes > 0 ? diff([], maxPatchBytes) : Promise.resolve(NO_PATCH),
    ] as const;
    await Promise.allSettled(work);
    const [names, stats, patch] = await Promise.all(work);
    return {
      // Ostatni wpis uciętej listy może mieć niepełną ścieżkę.
      files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")).slice(0, names.truncated ? -1 : undefined),
      patch: patch.stdout.toString("utf8"),
      // Ucięta lista plików (dziesiątki tysięcy nowych plików bez `.gitignore`) też jest niepełnym wynikiem.
      truncated: patch.truncated || names.truncated || stats.truncated || untrackedTruncated,
    };
  } finally {
    // Pozostałość po gicie zabitym po limicie czasu; plik w katalogu tymczasowym nie jest wart przykrycia błędu.
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

/**
 * Nowe pliki katalogu roboczego (bez ignorowanych) jako wpisy indeksu `index` z hashem pustego bloba: `diff` z katalogiem
 * roboczym i tak czyta ich treść i tryb z dysku, a `update-index --index-info`, w przeciwieństwie do
 * `add --intent-to-add`, nie zapisuje bloba do `.git/objects`. Zwraca, czy lista nowych plików była ucięta.
 */
async function addUntracked(dir: string, index: string, emptyBlob: string): Promise<boolean> {
  const listed = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"], {
    indexFile: index,
    timeoutMs: CHANGES_TIMEOUT_MS,
  });
  const paths = parseNulTerminated(listed.stdout);
  const fileHeader = Buffer.from(`100644 ${emptyBlob}\t`);
  const files = paths.filter((path) => path.at(-1) !== SLASH).map((path) => Buffer.concat([fileHeader, path, NUL]));
  const repos = paths.filter((path) => path.at(-1) === SLASH).map((path) => path.subarray(0, -1));
  const submodules = await mapLimit(repos, SUBMODULE_CONCURRENCY, (repo) => submoduleEntry(dir, repo, emptyBlob.length));
  const indexInfo = Buffer.concat([...files, ...submodules.filter((entry) => entry !== undefined)]);
  if (indexInfo.length > 0)
    await git(dir, ["update-index", "-z", "--index-info"], { indexFile: index, stdin: indexInfo, timeoutMs: CHANGES_TIMEOUT_MS });
  return listed.truncated;
}

/**
 * Katalog z własnym repo (`ls-files` podaje go z `/` na końcu) to wpis submodułu z HEAD tamtego repo, jak przy
 * `git add`. Repo bez commitów albo z hashem innej długości niż w repo zadania (inny format obiektów, SHA-1 w SHA-256)
 * odpada, tak jak pomijało je wcześniej `git add --ignore-errors`: jeden zły wpis odrzuciłby cały `update-index`.
 */
async function submoduleEntry(dir: string, repo: Buffer, oidLength: number): Promise<Buffer | undefined> {
  const head = await revParse(resolve(dir, repo.toString("utf8")), "HEAD");
  if (head === undefined || head.length !== oidLength) return undefined;
  return Buffer.concat([Buffer.from(`160000 ${head}\t`), repo, NUL]);
}

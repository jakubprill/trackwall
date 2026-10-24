import type { CardProblem, TreeEntry } from "@trackwall/protocol";
import { messageOf } from "../../errors.ts";
import type { RepoSnapshot } from "./snapshot.ts";

/**
 * Odczyt commita dla ekstraktorów: lista plików (`ls-tree`), pliki źródłowe wybrane wyszukiwaniem treści
 * (`git grep`, ADR-30) i treść plików wybranych przez `reads` razem ze źródłowymi jednym `cat-file --batch`, bez
 * katalogu roboczego (ADR-14), więc karta opisuje dokładnie ten commit. Czego nie przeczytał w limitach, trafia do
 * `problems` migawki, więc niepełna karta mówi, czego jej brakuje.
 */

/** Czego `cards` potrzebuje od `vcs` do odczytu commita; podłączane w fasadzie. */
export interface SnapshotVcs {
  commitFiles(dir: string, commit: string, maxBytes: number): Promise<{ files: TreeEntry[]; truncated: boolean }>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
  grepFiles(
    dir: string,
    commit: string,
    pattern: string,
    globs: readonly string[],
    maxBytes: number,
  ): Promise<{ paths: string[]; truncated: boolean }>;
}

/** Pliki źródłowe do przeczytania: pasujące do `globs` i `accepts`, z treścią pasującą do wyrażenia ERE `pattern`. */
export interface SourceSelection {
  pattern: string;
  globs: readonly string[];
  accepts: (path: string) => boolean;
}

/** Katalogi z zależnościami skopiowanymi do repo: ich pliki nie są częścią repo ani dla buildów, ani dla mechanizmów. */
const SKIPPED_DIRS = new Set(["node_modules", "bower_components"]);
/** Lista plików repo z setkami tysięcy plików; więcej to i tak nie repo z kodem aplikacji. */
const MAX_LIST_BYTES = 64 * 1024 * 1024;
/** Plik buildu większy niż to jest wygenerowany albo nie jest plikiem buildu. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
/** Plików źródłowych z wyszukiwania: kontrolery i klienci HTTP to ułamek kodu, więc tyle mieści się nawet w dużym monorepo. */
const MAX_SOURCE_FILES = 3000;
/** Lista nazw z `git grep`: 3000 ścieżek po 300 znaków to niecały 1 MB. */
const MAX_GREP_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;

export async function readSnapshot(
  vcs: SnapshotVcs,
  dir: string,
  commit: string,
  reads: (path: string) => boolean,
  sources: SourceSelection,
): Promise<RepoSnapshot> {
  const problems: CardProblem[] = [];
  const listed = await vcs.commitFiles(dir, commit, MAX_LIST_BYTES);
  if (listed.truncated)
    problems.push({
      path: "",
      message: `the commit's file list is longer than ${MAX_LIST_BYTES} B; the card describes only its beginning`,
    });
  const files = listed.files.filter((f) => !f.path.split("/").some((segment) => SKIPPED_DIRS.has(segment)));
  const wanted = files.filter((f) => reads(f.path) && isReadable(f)).map((f) => f.path);
  if (wanted.length > MAX_FILES)
    problems.push({ path: "", message: `the repo has ${wanted.length} build files; the card reads the first ${MAX_FILES}` });
  const requested = [...wanted.slice(0, MAX_FILES), ...(await sourceFiles(vcs, dir, commit, files, sources, problems))];
  const contents = await vcs.readFiles(dir, commit, requested, MAX_READ_BYTES);
  for (const path of requested)
    if (!contents.has(path)) problems.push({ path, message: `the file was not read within the ${MAX_READ_BYTES} B commit read limit` });
  const texts = new Map([...contents].map(([path, content]) => [path, toText(content)]));
  return { commit, paths: files.map((f) => f.path), text: (path) => texts.get(path), problems };
}

/**
 * Pliki źródłowe z wyszukiwania treści w commicie; repo bez żadnego pliku pasującego do `accepts` nie uruchamia
 * `git grep` wcale.
 */
async function sourceFiles(
  vcs: SnapshotVcs,
  dir: string,
  commit: string,
  files: readonly TreeEntry[],
  sources: SourceSelection,
  problems: CardProblem[],
): Promise<string[]> {
  const candidates = new Map(files.filter((f) => sources.accepts(f.path) && isReadable(f)).map((f) => [f.path, f]));
  if (candidates.size === 0) return [];
  let found: { paths: string[]; truncated: boolean };
  try {
    found = await vcs.grepFiles(dir, commit, sources.pattern, sources.globs, MAX_GREP_BYTES);
  } catch (err) {
    // Błąd wyszukiwania (np. limit czasu w ogromnym repo) zabiera tylko fakty z kodu, nie karta z plików buildu.
    problems.push({ path: "", message: `searching for files with controllers and HTTP clients failed: ${messageOf(err)}` });
    return [];
  }
  const matched = found.paths.filter((p) => candidates.has(p));
  if (found.truncated || matched.length > MAX_SOURCE_FILES)
    problems.push({
      path: "",
      message: `the repo has more than ${MAX_SOURCE_FILES} files with controllers or HTTP clients; the card reads the first ones`,
    });
  return matched.slice(0, MAX_SOURCE_FILES);
}

/** Plik do przeczytania: w limicie rozmiaru i bez znaków sterujących, bo ścieżki idą do gita liniami. */
function isReadable(file: TreeEntry): boolean {
  return (file.size ?? 0) <= MAX_FILE_BYTES && ![...file.path].some((c) => c < " ");
}

/** Tekst bez BOM i z `\n` zamiast `\r\n`, żeby wyrażenia i numery linii działały tak samo dla plików z Windowsa. */
function toText(content: Buffer): string {
  return content.toString("utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
}

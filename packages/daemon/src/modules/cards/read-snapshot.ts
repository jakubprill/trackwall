import type { CardProblem, TreeEntry } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { stemOf } from "./repo-path.ts";
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
  /**
   * Nazwy typów, które plik źródłowy wymienia (ADR-38). Odczyt dociąga pliki źródłowe o tych nazwach (`OrderDto.java`,
   * `OrderDto.kt`), w kolejnych rundach także nazwy z nich, bo DTO z kontraktu endpointu zwykle nie ma adnotacji,
   * po której wyszukiwanie by go znalazło.
   */
  referencedTypes: (text: string) => Iterable<string>;
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
/** Rundy dociągania plików typów: kontroler → DTO → typ pola → typ pola zagnieżdżonego. */
const RELATED_ROUNDS = 3;
/** Plików dociągniętych po nazwach typów razem ze wszystkich rund. */
const MAX_RELATED_FILES = 3000;

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
  const reader = new BudgetedReader(vcs, dir, commit, problems);
  await reader.read(requested);
  await readRelated(reader, files, sources, problems);
  return { commit, paths: files.map((f) => f.path), text: (path) => reader.texts.get(path), problems };
}

/** Odczyt plików commita w kolejnych porcjach ze wspólnym limitem `MAX_READ_BYTES`. */
class BudgetedReader {
  readonly texts = new Map<string, string>();
  private bytes = 0;
  private readonly vcs: SnapshotVcs;
  private readonly dir: string;
  private readonly commit: string;
  private readonly problems: CardProblem[];

  constructor(vcs: SnapshotVcs, dir: string, commit: string, problems: CardProblem[]) {
    this.vcs = vcs;
    this.dir = dir;
    this.commit = commit;
    this.problems = problems;
  }

  async read(paths: readonly string[]): Promise<void> {
    const left = MAX_READ_BYTES - this.bytes;
    const contents =
      paths.length === 0 || left <= 0 ? new Map<string, Buffer>() : await this.vcs.readFiles(this.dir, this.commit, paths, left);
    for (const path of paths) {
      const content = contents.get(path);
      if (content === undefined) {
        this.problems.push({ path, message: `the file was not read within the ${MAX_READ_BYTES} B commit read limit` });
        continue;
      }
      this.bytes += content.length;
      this.texts.set(path, toText(content));
    }
  }
}

/**
 * Pliki źródłowe o nazwach typów, które wymieniają już przeczytane pliki źródłowe, w `RELATED_ROUNDS` rundach.
 * Nazwa pliku to jedyne, co odczyt wie o typie bez parsowania; typ z pliku o innej nazwie (kilka `data class`
 * w jednym pliku Kotlina) zostaje bez pól, chyba że ten plik i tak był czytany.
 */
async function readRelated(reader: BudgetedReader, files: readonly TreeEntry[], sources: SourceSelection, problems: CardProblem[]) {
  const byType = sourcesByTypeName(files, sources);
  let fresh = [...reader.texts.keys()].filter(sources.accepts);
  let budget = MAX_RELATED_FILES;
  for (let round = 0; round < RELATED_ROUNDS && fresh.length > 0; round++) {
    const next = [...referencedFiles(fresh, reader, byType, sources)];
    const batch = next.slice(0, budget);
    if (batch.length < next.length)
      problems.push({
        path: "",
        message: `the repo references more than ${MAX_RELATED_FILES} type files from HTTP code; the card reads the first ones`,
      });
    budget -= batch.length;
    await reader.read(batch);
    fresh = batch.filter((p) => reader.texts.has(p));
  }
}

/** Pliki źródłowe, które można przeczytać, po nazwie typu z nazwy pliku. */
function sourcesByTypeName(files: readonly TreeEntry[], sources: SourceSelection): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const f of files.filter((f) => sources.accepts(f.path) && isReadable(f))) {
    const paths = byType.get(stemOf(f.path));
    if (paths) paths.push(f.path);
    else byType.set(stemOf(f.path), [f.path]);
  }
  return byType;
}

/** Jeszcze nieprzeczytane pliki typów, które wymieniają pliki `paths`. */
function referencedFiles(
  paths: readonly string[],
  reader: BudgetedReader,
  byType: Map<string, string[]>,
  sources: SourceSelection,
): Set<string> {
  const found = new Set<string>();
  for (const path of paths)
    for (const name of sources.referencedTypes(reader.texts.get(path) ?? ""))
      for (const candidate of byType.get(name) ?? []) if (!reader.texts.has(candidate)) found.add(candidate);
  return found;
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

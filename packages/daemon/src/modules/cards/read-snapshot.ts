import type { CardProblem, TreeEntry } from "@trackwall/protocol";
import type { RepoSnapshot } from "./snapshot.ts";

/**
 * Odczyt commita dla ekstraktorów: lista plików (`ls-tree`) i treść plików wybranych przez `reads` jednym
 * `cat-file --batch`, bez katalogu roboczego (ADR-14), więc karta opisuje dokładnie ten commit. Czego nie przeczytał
 * w limitach, trafia do `problems` migawki, więc niepełna karta mówi, czego jej brakuje.
 */

/** Czego `cards` potrzebuje od `vcs` do odczytu commita; podłączane w fasadzie. */
export interface SnapshotVcs {
  commitFiles(dir: string, commit: string, maxBytes: number): Promise<{ files: TreeEntry[]; truncated: boolean }>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
}

/** Katalogi z zależnościami skopiowanymi do repo: ich pliki nie są częścią repo ani dla buildów, ani dla mechanizmów. */
const SKIPPED_DIRS = new Set(["node_modules", "bower_components"]);
/** Lista plików repo z setkami tysięcy plików; więcej to i tak nie repo z kodem aplikacji. */
const MAX_LIST_BYTES = 64 * 1024 * 1024;
/** Plik buildu większy niż to jest wygenerowany albo nie jest plikiem buildu. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_READ_BYTES = 32 * 1024 * 1024;

export async function readSnapshot(vcs: SnapshotVcs, dir: string, commit: string, reads: (path: string) => boolean): Promise<RepoSnapshot> {
  const problems: CardProblem[] = [];
  const listed = await vcs.commitFiles(dir, commit, MAX_LIST_BYTES);
  if (listed.truncated)
    problems.push({ path: "", message: `lista plików commita jest dłuższa niż ${MAX_LIST_BYTES} B; karta opisuje tylko jej początek` });
  const files = listed.files.filter((f) => !f.path.split("/").some((segment) => SKIPPED_DIRS.has(segment)));
  const wanted = files.filter((f) => reads(f.path) && isReadable(f)).map((f) => f.path);
  if (wanted.length > MAX_FILES)
    problems.push({ path: "", message: `repo ma ${wanted.length} plików buildu; karta czyta pierwsze ${MAX_FILES}` });
  const requested = wanted.slice(0, MAX_FILES);
  const contents = await vcs.readFiles(dir, commit, requested, MAX_READ_BYTES);
  for (const path of requested)
    if (!contents.has(path)) problems.push({ path, message: `pliku nie przeczytano w limicie ${MAX_READ_BYTES} B odczytu commita` });
  const texts = new Map([...contents].map(([path, content]) => [path, toText(content)]));
  return { commit, paths: files.map((f) => f.path), text: (path) => texts.get(path), problems };
}

/** Plik do przeczytania: w limicie rozmiaru i bez znaków sterujących, bo ścieżki idą do gita liniami. */
function isReadable(file: TreeEntry): boolean {
  return (file.size ?? 0) <= MAX_FILE_BYTES && ![...file.path].some((c) => c < " ");
}

/** Tekst bez BOM i z `\n` zamiast `\r\n`, żeby wyrażenia i numery linii działały tak samo dla plików z Windowsa. */
function toText(content: Buffer): string {
  return content.toString("utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
}

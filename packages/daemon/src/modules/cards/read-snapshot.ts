import type { CardProblem, TreeEntry } from "@trackwall/protocol";
import { baseName, type RepoSnapshot } from "./snapshot.ts";
import { TOOL_FILE_NAMES } from "./tools.ts";

/**
 * Odczyt commita dla ekstraktorów: lista plików (`ls-tree`) i treść plików buildu i konfiguracji jednym
 * `cat-file --batch`, bez katalogu roboczego (ADR-14), więc karta opisuje dokładnie ten commit.
 */

/** Czego `cards` potrzebuje od `vcs` do odczytu commita; podłączane w fasadzie. */
export interface SnapshotVcs {
  commitFiles(dir: string, commit: string, maxBytes: number): Promise<{ files: TreeEntry[]; truncated: boolean }>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
}

const BUILD_FILE_NAMES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "libs.versions.toml",
  "package.json",
  "pnpm-workspace.yaml",
]);
/** Katalogi, w których plik buildu nie jest częścią repo, tylko zależnością skopiowaną do niego. */
const SKIPPED_DIRS = new Set(["node_modules", "bower_components"]);
/** Lista plików repo z setkami tysięcy plików; więcej to i tak nie repo z kodem aplikacji. */
const MAX_LIST_BYTES = 64 * 1024 * 1024;
/** Plik buildu większy niż to jest wygenerowany albo nie jest plikiem buildu. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_READ_BYTES = 32 * 1024 * 1024;

export async function readSnapshot(
  vcs: SnapshotVcs,
  dir: string,
  commit: string,
): Promise<{ snapshot: RepoSnapshot; problems: CardProblem[] }> {
  const problems: CardProblem[] = [];
  const { files, truncated } = await vcs.commitFiles(dir, commit, MAX_LIST_BYTES);
  if (truncated)
    problems.push({ path: "", message: `lista plików commita jest dłuższa niż ${MAX_LIST_BYTES} B; karta opisuje tylko jej początek` });
  const wanted = files.filter(isWanted).map((f) => f.path);
  if (wanted.length > MAX_FILES)
    problems.push({ path: "", message: `repo ma ${wanted.length} plików buildu; karta czyta pierwsze ${MAX_FILES}` });
  const contents = await vcs.readFiles(dir, commit, wanted.slice(0, MAX_FILES), MAX_READ_BYTES);
  const texts = new Map([...contents].map(([path, content]) => [path, toText(content)]));
  return { snapshot: { commit, paths: files.map((f) => f.path), text: (path) => texts.get(path) }, problems };
}

function isWanted(file: TreeEntry): boolean {
  const name = baseName(file.path);
  if (!BUILD_FILE_NAMES.has(name) && !TOOL_FILE_NAMES.has(name)) return false;
  // Ścieżki idą do gita liniami, więc znak sterujący w nazwie rozbiłby zapytanie.
  if ([...file.path].some((c) => c < " ")) return false;
  return (file.size ?? 0) <= MAX_FILE_BYTES && !file.path.split("/").some((segment) => SKIPPED_DIRS.has(segment));
}

/** Tekst bez BOM i z `\n` zamiast `\r\n`, żeby wyrażenia i numery linii działały tak samo dla plików z Windowsa. */
function toText(content: Buffer): string {
  return content.toString("utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
}

import type { CardProblem, TreeEntry } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { stemOf } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";

/**
 * Reading a commit for the extractors: the file list (`ls-tree`), source files chosen by a content search (`git grep`,
 * ADR-30) and the content of the files chosen by `reads` together with the source files in one `cat-file --batch`,
 * without the working directory (ADR-14), so the card describes exactly this commit. Whatever it did not read within the
 * limits goes to the commit snapshot's `problems`, so an incomplete card says what it lacks.
 */

/** What `cards` needs from `vcs` to read a commit; wired in the facade. */
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

/** Source files to read: matching `globs` and `accepts`, with content matching the ERE expression `pattern`. */
export interface SourceSelection {
  pattern: string;
  globs: readonly string[];
  accepts: (path: string) => boolean;
  /**
   * The type names a source file mentions (ADR-38). The read fetches the source files with those names (`OrderDto.java`,
   * `OrderDto.kt`), in further rounds also the names from them, because a DTO from an endpoint contract usually has no
   * annotation the search would find it by.
   */
  referencedTypes: (text: string) => Iterable<string>;
}

/** Directories with dependencies copied into the repo: their files are not part of the repo, for builds or for mechanisms. */
const SKIPPED_DIRS = new Set(["node_modules", "bower_components"]);
/** A repo file list with hundreds of thousands of files; more is not a repo with app code anyway. */
const MAX_LIST_BYTES = 64 * 1024 * 1024;
/** A build file larger than this is generated or is not a build file. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
/** Source files from the search: controllers and HTTP clients are a fraction of the code, so this fits even in a large monorepo. */
const MAX_SOURCE_FILES = 3000;
/** The name list from `git grep`: 3000 paths of 300 characters is under 1 MB. */
const MAX_GREP_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** Rounds of fetching type files: controller → DTO → field type → nested field type. */
const RELATED_ROUNDS = 3;
/** Files fetched by type names, across all rounds together. */
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
      code: "files-not-read",
      path: "",
      message: `the commit's file list is longer than ${MAX_LIST_BYTES} B; the card describes only its beginning`,
    });
  const files = listed.files.filter((f) => !f.path.split("/").some((segment) => SKIPPED_DIRS.has(segment)));
  const wanted = files.filter((f) => reads(f.path) && isReadable(f)).map((f) => f.path);
  if (wanted.length > MAX_FILES)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `the repo has ${wanted.length} build files; the card reads the first ${MAX_FILES}`,
    });
  const requested = [...wanted.slice(0, MAX_FILES), ...(await sourceFiles(vcs, dir, commit, files, sources, problems))];
  const reader = new BudgetedReader(vcs, dir, commit);
  for (const path of await reader.read(requested))
    problems.push({ code: "files-not-read", path, message: `the file was not read within the ${MAX_READ_BYTES} B commit read limit` });
  const typeFiles = await readTypeFiles(reader, files, sources, new Set(requested), problems);
  return {
    commit,
    paths: files.map((f) => f.path),
    pathsTruncated: listed.truncated,
    text: (path) => reader.texts.get(path),
    typeFiles,
    problems,
  };
}

/** Reading the commit's files in successive batches with the shared `MAX_READ_BYTES` limit. */
class BudgetedReader {
  readonly texts = new Map<string, string>();
  private bytes = 0;
  private readonly vcs: SnapshotVcs;
  private readonly dir: string;
  private readonly commit: string;

  constructor(vcs: SnapshotVcs, dir: string, commit: string) {
    this.vcs = vcs;
    this.dir = dir;
    this.commit = commit;
  }

  /** Reads `paths` and returns the files that did not fit in the limit; the caller records a problem for each of them. */
  async read(paths: readonly string[]): Promise<string[]> {
    const left = MAX_READ_BYTES - this.bytes;
    const contents =
      paths.length === 0 || left <= 0 ? new Map<string, Buffer>() : await this.vcs.readFiles(this.dir, this.commit, paths, left);
    const missed: string[] = [];
    for (const path of paths) {
      const content = contents.get(path);
      if (content === undefined) {
        missed.push(path);
        continue;
      }
      this.bytes += content.length;
      this.texts.set(path, toText(content));
    }
    return missed;
  }
}

/**
 * Source files named after the types the already read source files mention, in `RELATED_ROUNDS` rounds; returns those
 * read. The file name is all the read knows about a type without parsing; a type from a file with another name (several
 * `data class` in one Kotlin file) stays without fields, unless that file was read anyway. The files are guessed by
 * name, so those that did not fit in the limits give one problem, not a problem per file.
 */
async function readTypeFiles(
  reader: BudgetedReader,
  files: readonly TreeEntry[],
  sources: SourceSelection,
  requested: ReadonlySet<string>,
  problems: CardProblem[],
): Promise<Set<string>> {
  // A file from the search that did not fit in the first read does not come back as a type file: the Spring extractor would skip it.
  const byType = sourcesByTypeName(files, sources, requested);
  const typeFiles = new Set<string>();
  let fresh = [...reader.texts.keys()].filter(sources.accepts);
  const skipped = new Set<string>();
  for (let round = 0; round < RELATED_ROUNDS && fresh.length > 0; round++) {
    const next = [...referencedFiles(fresh, reader, byType, sources)].filter((p) => !skipped.has(p));
    const batch = next.slice(0, MAX_RELATED_FILES - typeFiles.size);
    for (const path of next.slice(batch.length)) skipped.add(path);
    const missed = new Set(await reader.read(batch));
    for (const path of missed) skipped.add(path);
    fresh = batch.filter((p) => !missed.has(p));
    for (const path of fresh) typeFiles.add(path);
  }
  if (skipped.size > 0)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `${skipped.size} type files referenced from HTTP code were not read (at most ${MAX_RELATED_FILES} files within the ${MAX_READ_BYTES} B commit read limit); their DTOs are missing`,
    });
  return typeFiles;
}

/** Source files that can be read, by the type name from the file name, without `excluded`. */
function sourcesByTypeName(files: readonly TreeEntry[], sources: SourceSelection, excluded: ReadonlySet<string>): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const f of files.filter((f) => sources.accepts(f.path) && isReadable(f) && !excluded.has(f.path))) {
    const paths = byType.get(stemOf(f.path));
    if (paths) paths.push(f.path);
    else byType.set(stemOf(f.path), [f.path]);
  }
  return byType;
}

/** Type files not read yet that the files `paths` mention. */
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
 * Source files from the content search in the commit; a repo without any file matching `accepts` does not run
 * `git grep` at all.
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
    // A search error (e.g. a timeout in a huge repo) takes away only the facts from code, not the card from build files.
    problems.push({
      code: "files-not-read",
      path: "",
      message: `searching for files with controllers and HTTP clients failed: ${messageOf(err)}`,
    });
    return [];
  }
  const matched = found.paths.filter((p) => candidates.has(p));
  if (found.truncated || matched.length > MAX_SOURCE_FILES)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `the repo has more than ${MAX_SOURCE_FILES} files with controllers or HTTP clients; the card reads the first ones`,
    });
  return matched.slice(0, MAX_SOURCE_FILES);
}

/** A file to read: within the size limit and without control characters, because paths go to git line by line. */
function isReadable(file: TreeEntry): boolean {
  return (file.size ?? 0) <= MAX_FILE_BYTES && ![...file.path].some((c) => c < " ");
}

/** Text without a BOM and with `\n` instead of `\r\n`, so that expressions and line numbers work the same for files from Windows. */
function toText(content: Buffer): string {
  return content.toString("utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
}

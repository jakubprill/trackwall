import { posix } from "node:path";
import type { ChangeCardProblem, RepoCard, TypeChange } from "@trackwall/protocol";
import { type ApiType, readJavaApi } from "./java-api.ts";
import type { SyntaxParsers } from "./syntax-tree.ts";

/**
 * The public Java types a task's commits remove or change in the modules of its repo that build a Maven or Gradle
 * package (§4.6, ADR-205): another repo can depend on that package and import them. Only the Java files that differ
 * between the base and the head are read, on both sides, so a task touching no library code costs one `git diff`.
 * Kotlin files and code generated during the build are not read.
 */

/** Most changed library Java files looked at: a change of more is a generated or moved package, which a list of types would not help with. */
const API_FILES_MAX = 300;
/** All Java files read on one side of the comparison, together. */
const API_READ_MAX_BYTES = 8 * 1024 * 1024;

/** What reading the public types needs from `vcs`. */
export interface ApiChangesVcs {
  changedPathsBetween(
    dir: string,
    from: string,
    to: string,
    max: number,
    pathspecs: readonly string[],
  ): Promise<{ paths: string[]; truncated: boolean } | undefined>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
}

/** The public types of one Java file. */
export interface FileApi {
  path: string;
  types: ApiType[];
}

/**
 * The source folders of the modules that build a Maven package in either card (`src/main/java` next to each `pom.xml`
 * or Gradle build file), with a trailing `/`.
 */
export function librarySourceRoots(cards: readonly Pick<RepoCard, "provides">[]): string[] {
  const roots = cards.flatMap((card) =>
    card.provides.flatMap((p) => {
      if (p.kind !== "package" || p.ecosystem !== "maven") return [];
      const module = posix.dirname(p.evidence.path);
      return [`${module === "." ? "" : `${module}/`}src/main/java/`];
    }),
  );
  return [...new Set(roots)];
}

/** The removed and changed public types of a comparison, with what could not be read. */
export interface LibraryTypeChanges {
  types: TypeChange[];
  problems: ChangeCardProblem[];
}

/** The removed and changed public types between commits `base` and `head` in `roots`, with what could not be read. */
export async function apiChanges(
  vcs: ApiChangesVcs,
  dir: string,
  commits: { base: string; head: string },
  roots: readonly string[],
  parsers: SyntaxParsers,
): Promise<LibraryTypeChanges> {
  if (roots.length === 0) return { types: [], problems: [] };
  // The limit counts library Java files only, so a change of many other files does not push them out.
  const pathspecs = roots.map((root) => `${root}*.java`);
  const diff = await vcs.changedPathsBetween(dir, commits.base, commits.head, API_FILES_MAX, pathspecs);
  if (diff === undefined) throw new Error(`commit ${commits.base} is not in the repo`);
  const paths = diff.paths;
  const problems: ChangeCardProblem[] = [];
  if (diff.truncated)
    problems.push({
      code: "files-not-read",
      path: "",
      message: `more than ${API_FILES_MAX} changed library Java files; public types were compared only in the first ones`,
      commit: "head",
    });
  const [before, after] = await Promise.all([
    readSide(vcs, dir, commits.base, "base", paths, parsers, problems),
    readSide(vcs, dir, commits.head, "head", paths, parsers, problems),
  ]);
  // A changed file is on at least one side, so one missing from both did not fit in the read limit.
  const read = new Set([...before.files, ...after.files]);
  const unread = paths.filter((p) => !read.has(p));
  if (unread.length > 0)
    problems.push({
      code: "files-not-read",
      path: unread[0] ?? "",
      message: `${unread.length} changed Java files over the read limit were not compared for public types`,
      commit: "head",
    });
  // A file one side could not parse would look added or deleted, so neither side of it is compared.
  const failed = new Set([...before.failed, ...after.failed]);
  const compared = (apis: readonly FileApi[]) => apis.filter((a) => !failed.has(a.path));
  return { types: typeChanges(compared(before.apis), compared(after.apis)), problems };
}

async function readSide(
  vcs: ApiChangesVcs,
  dir: string,
  commit: string,
  side: "base" | "head",
  paths: readonly string[],
  parsers: SyntaxParsers,
  problems: ChangeCardProblem[],
): Promise<{ files: string[]; apis: FileApi[]; failed: string[] }> {
  const files = await vcs.readFiles(dir, commit, paths, API_READ_MAX_BYTES);
  const apis: FileApi[] = [];
  const failed: string[] = [];
  for (const [path, blob] of files) {
    // A file with syntax errors may lose a type or members in the tree, which would look removed.
    const result = parsers.read("java", blob.toString("utf8"), (root) => (root.hasError ? null : readJavaApi(root)));
    if (result.kind === "parsed" && result.value !== null) apis.push({ path, types: result.value });
    else {
      failed.push(path);
      const why = result.kind === "parsed" ? "syntax errors" : result.kind;
      problems.push({ code: "parse-incomplete", path, message: `public types not read: ${why}`, commit: side });
    }
  }
  return { files: [...files.keys()], apis, failed };
}

/**
 * The public types of `before` that `after` lacks or changed so that code using them may break: a member removed or
 * with another signature, a new abstract method, or another declaration. Added types and members are not listed.
 */
export function typeChanges(before: readonly FileApi[], after: readonly FileApi[]): TypeChange[] {
  const now = typesByName(after);
  const changes: TypeChange[] = [];
  for (const [name, was] of typesByName(before)) {
    const is = now.get(name);
    if (is === undefined) {
      changes.push(change("removed", was, false, []));
      continue;
    }
    const members = changedMembers(was.type.members, is.type.members);
    const declaration = was.type.header !== is.type.header;
    if (declaration || members.length > 0) changes.push(change("changed", is, declaration, members));
  }
  return changes;
}

function changedMembers(was: ReadonlyMap<string, string>, is: ReadonlyMap<string, string>): string[] {
  const gone = [...was].filter(([key, signature]) => is.get(key) !== signature).map(([key]) => key);
  const newlyAbstract = [...is].filter(([key, signature]) => !was.has(key) && signature.startsWith("abstract ")).map(([key]) => key);
  return [...gone, ...newlyAbstract];
}

function change(
  kind: TypeChange["change"],
  { path, type }: { path: string; type: ApiType },
  declaration: boolean,
  members: string[],
): TypeChange {
  return { change: kind, package: type.pkg, type: type.name, declaration, members, evidence: { path, line: type.line } };
}

function typesByName(files: readonly FileApi[]): Map<string, { path: string; type: ApiType }> {
  return new Map(files.flatMap(({ path, types }) => types.map((type) => [type.name, { path, type }] as const)));
}

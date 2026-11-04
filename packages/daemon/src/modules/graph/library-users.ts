import {
  type ChangedType,
  type CodeQuery,
  type CodeSearchOutput,
  type ImpactedRepo,
  MAX_CHANGED_TYPES,
  type RepoGraph,
  type SearchCodeResult,
  type TypeChange,
  type TypeUser,
} from "@trackwall/protocol";

/**
 * The users of the public Java types a task's commits remove or change (§4.6, ADR-201): the repos that depend on a
 * package of the task's repo in the graph (`depends-on` edges from build files) and import such a type, its outer type
 * or its whole package in the HEAD of their root. Imports are found with code search (`git grep`, ADR-40), not with
 * syntax trees: the consumers are many and an import is one line. A use by a fully qualified name without an import, or
 * from the same package, is not found.
 */

/** What finding users needs from code search (`workspace.searchCode`); wired in the facade. */
export type LibrarySearch = (
  query: CodeQuery & { limit: number; output: CodeSearchOutput },
  repos: readonly string[],
) => Promise<SearchCodeResult>;

/** Most import lines read for one change: a package imported everywhere stops the search here. */
const IMPORT_LINES_MAX = 2000;
/** The longest pattern code search takes (`CodeQuery.pattern`). */
const PATTERN_MAX = 500;

const PACKAGE_NAME = /^[\w$]+(\.[\w$]+)*$/;
const IMPORT_LINE = /^\s*import\s+(?:static\s+)?([\w$.*]+)\s*;/;

/** The repos of the graph that depend on a package of `repo`. */
export function packageConsumers(graph: RepoGraph, repo: string): string[] {
  return [...new Set(graph.edges.filter((e) => e.kind === "depends-on" && e.to === repo && e.from !== repo).map((e) => e.from))].sort();
}

/**
 * The first `MAX_CHANGED_TYPES` changes with the consumers that import each type, and whether something was left out:
 * more changes, or more import lines than `IMPORT_LINES_MAX`.
 */
export async function withUsers(
  changes: readonly TypeChange[],
  consumers: readonly string[],
  search: LibrarySearch,
): Promise<{ types: ChangedType[]; truncated: boolean }> {
  const shown = changes.slice(0, MAX_CHANGED_TYPES);
  const packages = [...new Set(shown.map((t) => t.package).filter((p) => p !== ""))];
  let cut = changes.length > shown.length;
  const imports: { repo: string; path: string; line: number; target: string }[] = [];
  if (consumers.length > 0)
    for (const pattern of importPatterns(packages)) {
      const found = await search(
        { pattern, regex: true, ignoreCase: false, paths: ["*.java"], context: 0, limit: IMPORT_LINES_MAX, output: "lines" },
        consumers,
      );
      cut ||= found.truncated;
      for (const m of found.matches) {
        const target = IMPORT_LINE.exec(m.text)?.[1];
        if (target !== undefined) imports.push({ repo: m.repo, path: m.path, line: m.line, target });
      }
    }
  const types = shown.map((type) => ({ ...type, users: usersOf(type, imports) }));
  return { types, truncated: cut };
}

/**
 * POSIX extended patterns (`git grep -E`) for import lines of any of the packages, each within `PATTERN_MAX`: one
 * pattern per group of packages that fits. Only a package name of letters, digits, `_`, `$` and dots is taken, so only
 * the dots and `$` need escaping.
 */
export function importPatterns(packages: readonly string[]): string[] {
  const head = "^[[:space:]]*import[[:space:]]+(static[[:space:]]+)?(";
  const tail = ")\\.";
  const patterns: string[] = [];
  let group: string[] = [];
  const flush = () => {
    if (group.length > 0) patterns.push(`${head}${group.join("|")}${tail}`);
    group = [];
  };
  for (const pkg of packages) {
    // A name read from a broken file could hold anything; only a real package name goes into the expression.
    if (!PACKAGE_NAME.test(pkg)) continue;
    const escaped = pkg.replace(/[.$]/g, "\\$&");
    if (head.length + tail.length + escaped.length > PATTERN_MAX) continue;
    if (head.length + tail.length + [...group, escaped].join("|").length > PATTERN_MAX) flush();
    group.push(escaped);
  }
  flush();
  return patterns;
}

/** The repos importing the type, its outermost type (and with it every nested one) or its whole package, each once with the first line found. */
function usersOf(type: TypeChange, imports: readonly { repo: string; path: string; line: number; target: string }[]): TypeUser[] {
  if (type.package === "") return [];
  const outer = `${type.package}.${type.type.slice(type.package.length + 1).split(".")[0] ?? ""}`;
  const users = new Map<string, TypeUser>();
  for (const i of imports) {
    const uses = i.target === `${type.package}.*` || i.target === outer || i.target.startsWith(`${outer}.`);
    if (uses && !users.has(i.repo)) users.set(i.repo, { repo: i.repo, evidence: { path: i.path, line: i.line } });
  }
  return [...users.values()];
}

/**
 * The impact with the repos that import a changed type: one that the endpoints do not reach is added to ring 1, surely
 * reached, with no calls and nothing it carries on through HTTP. One already there keeps its ring.
 */
export function withLibraryUsers(impact: readonly ImpactedRepo[], repo: string, types: readonly ChangedType[]): ImpactedRepo[] {
  const reached = new Set(impact.map((r) => r.repo));
  const users = [...new Set(types.flatMap((t) => t.users.map((u) => u.repo)))].filter((u) => !reached.has(u));
  const added = users.map((user): ImpactedRepo => ({ repo: user, ring: 1, uses: [repo], calls: [], through: [], sure: true }));
  const ring1 = [...impact.filter((r) => r.ring === 1), ...added].sort((a, b) => a.repo.localeCompare(b.repo));
  return [...ring1, ...impact.filter((r) => r.ring !== 1)];
}

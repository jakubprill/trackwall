import { posix } from "node:path";

/**
 * The repo's rules a task's change is checked against (ADR-234, §4.4): the files agents read as their instructions
 * (`AGENTS.md` and `CLAUDE.md` at the root and above every changed file, Copilot's instruction files) and the decision
 * records in the usual ADR folders, as the task's base commit holds them. Read from the base commit, not the worktree,
 * so a change that edits or deletes a rule is judged by the rule as it stood, and a rule file the agent added does not
 * count.
 */

/** Rule files at the root of the repo: what Copilot CLI and other agents load as the repo's instructions. */
const ROOT_RULE_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"] as const;
/** Instruction files an agent loads too, also from the folder of a changed file and the folders above it. */
const NESTED_RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Copilot's path-specific instructions (`*.instructions.md`). */
const INSTRUCTIONS_DIR = ".github/instructions";
const INSTRUCTIONS_SUFFIX = ".instructions.md";
/** Where repos usually keep their architecture decision records, one Markdown file each. */
const ADR_DIRS = ["docs/adr", "docs/adrs", "docs/decisions", "docs/architecture/decisions", "doc/adr", "adr", "adrs"] as const;

/** Most rule files a check gets: a repo with more ADRs gets the highest-numbered ones first after the instructions. */
export const RULE_FILES_MAX = 60;
/** Most bytes of rule files a check copies; a file past it is left out, and the check counts it in `RepoRules.omitted`. */
const RULE_BYTES_MAX = 1024 * 1024;
/** Most bytes of `ls-tree` output read while listing them. */
const LIST_MAX_BYTES = 256 * 1024;

/** What the rules need from `vcs`. */
export interface RulesVcs {
  filesAt(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<{ paths: string[]; truncated: boolean }>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
}

/**
 * The repo's rules for a change: each file's path relative to the repo root with `/` and its content at the base commit,
 * and how many rule files there were beyond what a check takes (`RULE_FILES_MAX`, `RULE_BYTES_MAX`, a listing cut).
 */
export interface RepoRules {
  files: Map<string, Buffer>;
  omitted: number;
}

/** Where rule files are looked for, in words, for a refusal that says why a repo has none. */
export const RULE_PLACES = `${[...ROOT_RULE_FILES, `${INSTRUCTIONS_DIR}/*${INSTRUCTIONS_SUFFIX}`].join(", ")}, AGENTS.md or CLAUDE.md above a changed file, or decision records in ${ADR_DIRS.join(", ")}`;

/**
 * The folders whose `AGENTS.md` and `CLAUDE.md` apply to a change of `changed` (paths relative to the root with `/`): every
 * folder above a changed file. They go to git on its standard input (`readFiles`), not as arguments, since a change of
 * many folders would pass Windows' limit of a command line.
 */
export function nestedCandidates(changed: readonly string[]): string[] {
  const nested = new Set<string>();
  for (const path of changed)
    for (let dir = posix.dirname(path); dir !== "." && dir !== "/"; dir = posix.dirname(dir))
      for (const name of NESTED_RULE_FILES) nested.add(`${dir}/${name}`);
  return [...nested].sort();
}

/** The fixed places listed with `ls-tree`: the root's instructions, Copilot's instruction folder and the ADR folders. */
export const FIXED_RULE_PLACES: readonly string[] = [...ROOT_RULE_FILES, INSTRUCTIONS_DIR, ...ADR_DIRS];

/**
 * The rule files among `listed`, in the order a reader takes them: the instructions (root first, then nested ones and
 * Copilot's path-specific files) before the decision records, highest-numbered first. A folder's other files (images,
 * templates) are not rules.
 */
export function ruleFiles(listed: readonly string[]): string[] {
  const instructions = listed.filter((path) => isInstruction(path));
  const decisions = listed
    .filter((path) => ADR_DIRS.some((dir) => path.startsWith(`${dir}/`)) && path.toLowerCase().endsWith(".md"))
    .filter((path) => !/(^|\/)(readme|template|index)[^/]*\.md$/i.test(path))
    // Numbered records sort by number; the newest decisions are the ones a change most likely meets.
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const rank = (path: string) => (ROOT_RULE_FILES.some((root) => root === path) ? 0 : path.startsWith(`${INSTRUCTIONS_DIR}/`) ? 2 : 1);
  instructions.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en"));
  return [...new Set([...instructions, ...decisions])];
}

function isInstruction(path: string): boolean {
  if (ROOT_RULE_FILES.some((root) => root === path)) return true;
  if (path.startsWith(`${INSTRUCTIONS_DIR}/`)) return path.endsWith(INSTRUCTIONS_SUFFIX);
  return NESTED_RULE_FILES.some((name) => path.endsWith(`/${name}`));
}

/** The repo's rules for a change of `changed` in `worktree`, from its base commit `base`; no files when the repo has none. */
export async function readRepoRules(vcs: RulesVcs, worktree: string, base: string, changed: readonly string[]): Promise<RepoRules> {
  const listed = await vcs.filesAt(worktree, base, FIXED_RULE_PLACES, LIST_MAX_BYTES);
  // Only the nested files that exist: `cat-file --batch` leaves a missing path out (and those past 1 MiB, unlikely for instructions).
  const nested = await vcs.readFiles(worktree, base, nestedCandidates(changed), RULE_BYTES_MAX);
  const all = ruleFiles([...listed.paths, ...nested.keys()]);
  const taken = all.slice(0, RULE_FILES_MAX);
  const files = await vcs.readFiles(worktree, base, taken, RULE_BYTES_MAX);
  // A cut listing may have hidden more; it counts as one, since how many is unknown.
  return { files, omitted: all.length - files.size + (listed.truncated ? 1 : 0) };
}

import {
  COMMIT_SEARCH_MAX_FILES,
  type CommitQuery,
  type CommitSearchRepo,
  type FoundCommit,
  type SearchCommitsResult,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * Commit search in many repos of the projects folder (§4.5, ADR-149): `git log` over each repo's HEAD history, the
 * commits of all repos joined newest first and cut to the limit. A repo git cannot search goes to `failed` and does
 * not take away the results of the others, as in code search (`code-search.ts`).
 */

export interface CommitSearchQuery extends CommitQuery {
  /** Most commits in the result. */
  limit: number;
}

/** One commit `vcs` found, before the repo id is added. */
interface LoggedCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

/** What commit search needs from `vcs`. */
export interface CommitSearchVcs {
  headCommit(dir: string): Promise<string | null>;
  searchLog(
    dir: string,
    commit: string,
    query: CommitQuery,
    limit: number,
    maxBytes: number,
  ): Promise<{ commits: LoggedCommit[]; truncated: boolean }>;
}

/** As in code search: each `git log` with the pickaxe keeps a core busy, so more at once only splits the CPU. */
const SEARCH_CONCURRENCY = 4;
/** Git output limit per repo: `limit` commits with their file lists, yet bounded memory. */
const LOG_MAX_BYTES = 1024 * 1024;
/** After this long no new repo is searched (it goes to `skipped`): an MCP client gives up on a call after a minute or two. */
const COMMIT_SEARCH_BUDGET_MS = 60_000;

type RepoOutcome =
  | { kind: "ok"; searched: CommitSearchRepo; commits: FoundCommit[] }
  | { kind: "empty" }
  | { kind: "skipped"; repo: string }
  | { kind: "failed"; repo: string; message: string };

export async function searchCommits(
  entries: readonly RepoEntry[],
  vcs: CommitSearchVcs,
  query: CommitSearchQuery,
  budgetMs = COMMIT_SEARCH_BUDGET_MS,
): Promise<SearchCommitsResult> {
  const deadline = Date.now() + budgetMs;
  // Unlike code search, every repo is searched: the newest commits may be in the last repo of the list.
  const outcomes = await mapLimit(entries, SEARCH_CONCURRENCY, async (entry): Promise<RepoOutcome> => {
    if (Date.now() >= deadline) return { kind: "skipped", repo: entry.id };
    return searchRepo(entry, vcs, query);
  });
  return joinOutcomes(outcomes, query.limit);
}

/** The commits of all repos newest first, within `limit`; a repo whose commits were cut is `truncated`. */
function joinOutcomes(outcomes: readonly RepoOutcome[], limit: number): SearchCommitsResult {
  const result: SearchCommitsResult = { commits: [], truncated: false, searched: [], failed: [], skipped: [] };
  const all: FoundCommit[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "failed") result.failed.push({ repo: outcome.repo, message: outcome.message });
    if (outcome.kind === "skipped") result.skipped.push(outcome.repo);
    if (outcome.kind === "ok") all.push(...outcome.commits);
  }
  // ISO 8601 dates with different offsets do not sort as text, so by their instant.
  all.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  result.commits = all.slice(0, limit);
  const cut = new Set(all.slice(limit).map((c) => c.repo));
  for (const outcome of outcomes) {
    if (outcome.kind !== "ok") continue;
    const searched = { ...outcome.searched, truncated: outcome.searched.truncated || cut.has(outcome.searched.repo) };
    result.searched.push(searched);
  }
  result.truncated = result.skipped.length > 0 || result.searched.some((r) => r.truncated);
  return result;
}

async function searchRepo(entry: RepoEntry, vcs: CommitSearchVcs, query: CommitSearchQuery): Promise<RepoOutcome> {
  try {
    const commit = await vcs.headCommit(entry.path);
    if (commit === null) return { kind: "empty" };
    // One more than the limit tells whether the repo has more matching commits than the result can hold.
    const { commits, truncated } = await vcs.searchLog(entry.path, commit, query, query.limit + 1, LOG_MAX_BYTES);
    const more = commits.length > query.limit;
    return {
      kind: "ok",
      searched: { repo: entry.id, commit, truncated: truncated || more },
      commits: commits.slice(0, query.limit).map((c) => found(entry.id, c)),
    };
  } catch (err) {
    return { kind: "failed", repo: entry.id, message: messageOf(err) };
  }
}

function found(repo: string, commit: LoggedCommit): FoundCommit {
  const { files, ...rest } = commit;
  return { repo, ...rest, files: files.slice(0, COMMIT_SEARCH_MAX_FILES), filesTruncated: files.length > COMMIT_SEARCH_MAX_FILES };
}

import { countLabel } from "./plural.ts";
import type { UnpushedRepo } from "./workspace.ts";

/** What a repo's or the whole folder's unpushed work adds up to (ADR-162). */
export type UnpushedCounts = Pick<UnpushedRepo, "commits" | "changes" | "stashes">;

/** The sum over repos, for the folder's total. */
export function unpushedTotal(repos: readonly UnpushedCounts[]): UnpushedCounts {
  return repos.reduce(
    (sum, r) => ({ commits: sum.commits + r.commits, changes: sum.changes + r.changes, stashes: sum.stashes + r.stashes }),
    {
      commits: 0,
      changes: 0,
      stashes: 0,
    },
  );
}

/**
 * The parts of unpushed work with their counts, leaving out what is zero: "3 commits, 5 changed files, 1 stash". Shared by
 * the Home card and the doctor, so both name the same thing the same way.
 */
export function unpushedSummary(work: UnpushedCounts): string {
  const parts = [
    work.commits > 0 ? countLabel(work.commits, { one: "commit", other: "commits" }) : null,
    work.changes > 0 ? countLabel(work.changes, { one: "changed file", other: "changed files" }) : null,
    work.stashes > 0 ? countLabel(work.stashes, { one: "stash", other: "stashes" }) : null,
  ];
  return parts.filter((part) => part !== null).join(", ");
}

import type { RepoTag, RepoTags } from "@trackwall/protocol";

/**
 * Filtering the repo list by tags (ADR-25): the chosen tags narrow the list, so a repo has to have every one of them
 * ("java" + "bff" is a BFF in Java). Pure functions, tested without React.
 */

/** The tags of the repos in the list by identifier; a repo git cannot read has no tags. */
export function tagsByRepo(list: readonly RepoTags[] | undefined): Map<string, RepoTag[]> {
  return new Map((list ?? []).map((entry) => [entry.repo, entry.kind === "ok" ? entry.tags : []]));
}

/**
 * Every tag with the number of repos that have it: the most common first, by name on a tie. A chosen tag no repo has
 * any more (changed rules or projects folder) stays with the count 0, so that it can be unchecked.
 */
export function tagCounts(byRepo: ReadonlyMap<string, readonly RepoTag[]>, selected: readonly string[]): { name: string; count: number }[] {
  const counts = new Map(selected.map((name) => [name, 0]));
  for (const tags of byRepo.values()) for (const tag of tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether the repo has all the chosen tags; with none chosen, every repo matches. */
export function hasAllTags(tags: readonly RepoTag[] | undefined, selected: readonly string[]): boolean {
  return selected.every((name) => tags?.some((tag) => tag.name === name) ?? false);
}

/** Wybrany tag znika z wyboru, niewybrany dochodzi. */
export function toggleTag(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}

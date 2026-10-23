import type { RepoTag, RepoTags } from "@trackwall/protocol";

/**
 * Filtr listy repo po tagach (ADR-25): wybrane tagi zawężają listę, więc repo musi mieć każdy z nich
 * („java” + „bff” to BFF w Javie). Czyste funkcje, testowane bez Reacta.
 */

/** Tagi repo z listy po identyfikatorze; repo, którego git nie czyta, nie ma tagów. */
export function tagsByRepo(list: readonly RepoTags[] | undefined): Map<string, RepoTag[]> {
  return new Map((list ?? []).map((entry) => [entry.repo, entry.kind === "ok" ? entry.tags : []]));
}

/** Każdy tag z liczbą repo, które go mają: najczęstsze najpierw, przy równej liczbie po nazwie. */
export function tagCounts(byRepo: ReadonlyMap<string, readonly RepoTag[]>): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of byRepo.values()) for (const tag of tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Czy repo ma wszystkie wybrane tagi; bez wybranych pasuje każde. */
export function hasAllTags(tags: readonly RepoTag[] | undefined, selected: readonly string[]): boolean {
  return selected.every((name) => tags?.some((tag) => tag.name === name) ?? false);
}

/** Wybrany tag znika z wyboru, niewybrany dochodzi. */
export function toggleTag(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}

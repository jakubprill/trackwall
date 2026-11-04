/**
 * The order of the repo list with stars (ADR-192): the starred repos first, then the rest, each part in the list's own
 * order (by directory name), so a star moves a repo to the top without reshuffling the others.
 */
export function starredFirst<R extends { id: string }>(repos: readonly R[], starred: readonly string[]): R[] {
  const stars = new Set(starred);
  return [...repos.filter((r) => stars.has(r.id)), ...repos.filter((r) => !stars.has(r.id))];
}

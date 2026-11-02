import type { EdgeConfidence, GraphEdge, KnowledgeListEntry } from "@trackwall/protocol";

/**
 * What Trackwall knows about the merge order of a change's repos (ADR-172), shown where the user sets the order: the
 * New session form and the card of a proposed change. The connection graph knows which repo uses which, and a repo is
 * merged before the repos that use it, so an edge against the order is a hint; workspace knowledge of kind `relation`
 * knows the links the graph does not see, which only a person can weigh, so it is shown as it is. Hints only: the order
 * stays the user's (ADR-171). No React here, so the wording is tested on its own.
 */

/** A guess on one shared path or port is too weak to argue with the user's order. */
const HINTING_CONFIDENCE: ReadonlySet<EdgeConfidence> = new Set(["exact", "high", "medium"]);

/** A repo of the change that uses another one placed after it: `user` comes later in the merge order than it should. */
export interface OrderHint {
  user: string;
  used: string;
  text: string;
}

/**
 * The graph's edges between the change's repos that go against their order, one per pair, in the order of the repos.
 * Both repos of a cycle use each other, so neither order is wrong and a cycle gives no hint.
 */
export function orderHints(repos: readonly string[], edges: readonly GraphEdge[]): OrderHint[] {
  const strong = edges.filter((edge) => edge.from !== edge.to && HINTING_CONFIDENCE.has(edge.confidence));
  const uses = (from: string, to: string) => strong.find((edge) => edge.from === from && edge.to === to);
  return repos.flatMap((user, index) =>
    repos.slice(index + 1).flatMap((used) => {
      const edge = uses(user, used);
      return edge && !uses(used, user) ? [{ user, used, text: hintText(edge) }] : [];
    }),
  );
}

/** `orders-api calls payments, so payments is usually merged first.` */
function hintText(edge: GraphEdge): string {
  const verb = edge.kind === "calls" ? "calls" : "depends on";
  return `${edge.from} ${verb} ${edge.to}, so ${edge.to} is usually merged first.`;
}

/** The approved `relation` entries of workspace knowledge about at least two of the change's repos. */
export function orderRelations(repos: readonly string[], entries: readonly KnowledgeListEntry[]): KnowledgeListEntry[] {
  return entries.filter(
    (entry) => entry.kind === "relation" && entry.approved && entry.repos.filter((repo) => repos.includes(repo)).length >= 2,
  );
}

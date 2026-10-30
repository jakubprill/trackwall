import type { EdgeConfidence, EdgeEvidence, GraphEdge } from "@trackwall/protocol";
import type { GraphCardInput } from "./graph-input.ts";

/**
 * Shared by the steps that join cards into the graph (§4.6, ADR-29, ADR-30): a set of edges without repeats, resolving
 * repo references from `workspace.yaml`, and entry errors.
 */

/** Shared by the join steps: edges, resolving repo references and entry errors from `workspace.yaml`. */
export interface Join {
  edges: EdgeSet;
  resolve: (ref: string) => string[];
  /** Errors in the `graph` entries of `workspace.yaml`, for `RepoGraph.configProblems`. */
  configProblems: string[];
  /**
   * Package and app aliases as a `Map`: the name comes from a repo, and an object from YAML would for the name `constructor` or
   * `toString` give back a function from the prototype.
   */
  aliases: Map<string, string>;
  /** App aliases with a lower-case key (an app name or a host). */
  appAliases: Map<string, string>;
  file: string;
}

/** How much evidence stays on an edge made of several facts (a client in several profiles, many calls). */
const MAX_EVIDENCE = 20;
const CONFIDENCE_ORDER: EdgeConfidence[] = ["low", "medium", "high", "exact"];

/**
 * Edges without repeats: the same repo pair, kind, source and key is one edge. A second identical one adds evidence, and
 * the confidence stays the higher of the two (a Feign client with an address in two profiles is one connection).
 */
export class EdgeSet {
  private readonly edges = new Map<string, GraphEdge>();

  add(edge: GraphEdge): void {
    const id = [edge.from, edge.to, edge.kind, edge.source, edge.key].join("\u0000");
    const existing = this.edges.get(id);
    if (!existing) {
      this.edges.set(id, { ...edge, evidence: uniqueEvidence(edge.evidence) });
      return;
    }
    const confidence = strongerConfidence(existing.confidence, edge.confidence);
    this.edges.set(id, { ...existing, confidence, evidence: uniqueEvidence([...existing.evidence, ...edge.evidence]) });
  }

  sorted(): GraphEdge[] {
    return [...this.edges.values()].sort(
      (a, b) =>
        compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind) || compare(a.source, b.source) || compare(a.key, b.key),
    );
  }
}

function uniqueEvidence(evidence: readonly EdgeEvidence[]): EdgeEvidence[] {
  const seen = new Set<string>();
  return evidence
    .filter((e) => {
      const id = [e.repo, e.path, e.line, e.detail].join("\u0000");
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_EVIDENCE);
}

/** The surer of two confidences. */
export function strongerConfidence(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_ORDER.indexOf(b) > CONFIDENCE_ORDER.indexOf(a) ? b : a;
}

/** Appends a value to the list under a key, without copying the list. */
export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Without `localeCompare`: the order must not depend on the ICU data in Bun and Node (like `byName` in `workspace`). */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A repo reference from `workspace.yaml` (`RepoRef`): an identifier, and when there is no such one, the remote repo address,
 * case-insensitive (the repo host compares it that way). One address may have several repos on the list (a clone and a worktree).
 */
export function repoResolver(cards: readonly GraphCardInput[]): (ref: string) => string[] {
  const ids = new Set(cards.map((c) => c.repo));
  return (ref) => {
    if (ids.has(ref)) return [ref];
    const wanted = ref.toLowerCase();
    return cards.filter((c) => c.kind === "ok" && c.remote?.toLowerCase() === wanted).map((c) => c.repo);
  };
}

export function missingRepo(ref: string): string {
  return `no repo “${ref}” in the repo list (give its id or host/path address)`;
}

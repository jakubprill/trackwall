import type { EdgeKind, EdgeSource, GraphEdge, GraphProblem, HttpClientVia, RepoGraph } from "@trackwall/protocol";
import { HTTP_CLIENT_LABELS } from "./card.ts";

/**
 * Words for the connections and gaps of the "Overview" view (§4.6, ADR-116): what an edge says (`calls`, `depends on`)
 * and where it comes from, and the graph's problems of one repo. `Record` forces an entry for every value in the contract.
 */

const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  "depends-on": "depends on",
  calls: "calls",
};

const EDGE_SOURCE_LABELS: Record<EdgeSource, string> = {
  package: "package",
  http: "HTTP",
  manual: "manual",
};

/** An edge for a person: what it says and where it comes from, `calls · HTTP`, `depends on · manual`. */
export function edgeLabel(edge: Pick<GraphEdge, "kind" | "source">): string {
  return `${EDGE_KIND_LABELS[edge.kind]} · ${EDGE_SOURCE_LABELS[edge.source]}`;
}

/** The graph's problems in one repo, in the graph's order. */
export function repoProblems(graph: Pick<RepoGraph, "problems">, repo: string): GraphProblem[] {
  return graph.problems.filter((p) => p.repo === repo);
}

/** A client in a problem for a person: `Feign PaymentsClient`. */
export function problemClient(problem: { via: HttpClientVia; client: string }): string {
  return `${HTTP_CLIENT_LABELS[problem.via]} ${problem.client}`;
}

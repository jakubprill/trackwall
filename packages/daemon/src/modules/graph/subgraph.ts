import type { RepoGraph, Subgraph } from "@trackwall/protocol";

/**
 * Repos within `depth` edges of `repo`, in both directions (whom it uses and who uses it), and the edges between
 * them, with the graph's problems in those repos. Nodes in graph order, so the result does not depend on the traversal order.
 */
export function subgraph(graph: RepoGraph, repo: string, depth: number): Subgraph {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
  for (const edge of graph.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const reached = new Set([repo]);
  let frontier = [repo];
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    frontier = frontier.flatMap((r) => [...(neighbours.get(r) ?? [])].filter((n) => !reached.has(n)));
    for (const r of frontier) reached.add(r);
  }

  return {
    repo,
    depth,
    nodes: graph.nodes.filter((n) => reached.has(n.repo)),
    edges: graph.edges.filter((e) => reached.has(e.from) && reached.has(e.to)),
    problems: graph.problems.filter((p) => reached.has(p.repo)),
  };
}

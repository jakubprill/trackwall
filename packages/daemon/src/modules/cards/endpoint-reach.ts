import type { ConsumedHttp, EndpointReach, Provided, ProvidedEndpoint } from "@trackwall/protocol";
import { buildCallGraph, type CallGraph } from "./call-graph.ts";
import { type CallFile, push } from "./call-types.ts";
import { strongComponents } from "./strong-components.ts";

/**
 * The endpoint reach (§4.6, ADR-82): for each endpoint, the client calls on the same card that its handler reaches
 * through the repo's call graph (`call-graph.ts`). A client call belongs to every method whose lines hold its line: the
 * body of a `RestTemplate`/`WebClient`/`RestClient` call, the mapping of a Feign or `@HttpExchange` method. Each
 * strongly connected component of the graph gets its set of calls once, in reverse topological order, so a repo costs
 * time linear in its calls, without a depth limit. Without call files (`null`: the card could not read the code) every
 * endpoint's `reaches` is `null`.
 */
export function withReaches(
  provides: readonly Provided[],
  clients: readonly ConsumedHttp[],
  files: readonly CallFile[] | null,
): Provided[] {
  if (files === null) return provides.map((p) => (p.kind === "endpoint" ? { ...p, reaches: null } : p));
  const graph = buildCallGraph(files);
  const sites = clientCalls(clients);
  const reach = reachByMethod(graph, sites);
  return provides.map((p) => {
    if (p.kind !== "endpoint") return p;
    const handler = handlerMethods(p, graph);
    if (handler === undefined) return { ...p, reaches: null };
    const reached = new Set(handler.flatMap((m) => [...(reach[m] ?? [])]));
    return { ...p, reaches: [...reached].sort((a, b) => a - b).flatMap((s) => sites[s] ?? []) };
  });
}

/**
 * Every call of every client as an `EndpointReach`, in card order; the index is the call's id below. A client whose
 * address differs by profile is on the card once per address with the same calls, which are one call in the code.
 */
function clientCalls(clients: readonly ConsumedHttp[]): EndpointReach[] {
  const seen = new Set<string>();
  return clients
    .flatMap((c) => c.calls.map((call) => ({ via: c.via, client: c.name, method: call.method, path: call.path, evidence: call.evidence })))
    .filter((site) => {
      const key = JSON.stringify([site.via, site.client, site.method, site.path, site.evidence.path, site.evidence.line]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** By method index, the ids of the client calls the method reaches, shared by the methods of one component. */
function reachByMethod(graph: CallGraph, sites: readonly EndpointReach[]): ReadonlySet<number>[] {
  const own = ownCalls(graph, sites);
  const components = strongComponents(graph.edges);
  const byComponent: Set<number>[] = [];
  // A component comes after every component it calls, so those are complete when it is computed.
  for (const nodes of components.members) byComponent.push(componentReach(nodes, own, graph.edges, components.of, byComponent));
  return components.of.map((component) => byComponent[component] ?? new Set());
}

/** The calls of a component's own methods and of every component it calls, computed before it. */
function componentReach(
  nodes: readonly number[],
  own: readonly number[][],
  edges: readonly number[][],
  of: readonly number[],
  done: readonly ReadonlySet<number>[],
): Set<number> {
  const reached = new Set<number>();
  for (const node of nodes) {
    for (const site of own[node] ?? []) reached.add(site);
    // An edge within the component points at the set being built, which is not in `done` yet.
    for (const next of edges[node] ?? []) for (const site of done[of[next] ?? -1] ?? []) reached.add(site);
  }
  return reached;
}

/** By method index, the client calls whose line lies within the method in the same file. */
function ownCalls(graph: CallGraph, sites: readonly EndpointReach[]): number[][] {
  const byPath = new Map<string, number[]>();
  graph.methods.forEach((m, i) => {
    push(byPath, m.owner.file.path, i);
  });
  const own: number[][] = graph.methods.map(() => []);
  sites.forEach((site, id) => {
    const line = site.evidence.line;
    if (line === null) return;
    for (const i of byPath.get(site.evidence.path) ?? []) {
      const method = graph.methods[i]?.method;
      if (method && line >= method.startLine && line <= method.endLine) own[i]?.push(id);
    }
  });
  return own;
}

/**
 * The method indexes of an endpoint's handler (`Class.method`); `undefined` when the files do not have it or the endpoint
 * has none (an OpenAPI operation without a controller method, ADR-87). The overload whose lines hold the mapping, and all
 * overloads when the mapping is elsewhere (an API interface the controller implements, an OpenAPI spec).
 */
function handlerMethods(endpoint: ProvidedEndpoint, graph: CallGraph): number[] | undefined {
  const { handler } = endpoint;
  if (handler === null) return undefined;
  const dot = handler.lastIndexOf(".");
  const controller = graph.types.named(handler.slice(0, dot), endpoint.evidence.path);
  const methods = controller ? graph.types.declared(controller, handler.slice(dot + 1), -1) : [];
  const line = endpoint.evidence.line ?? -1;
  const mapped = methods.filter(
    (m) => m.owner.file.path === endpoint.evidence.path && line >= m.method.startLine && line <= m.method.endLine,
  );
  const indexes = (mapped.length > 0 ? mapped : methods).flatMap((m) => graph.index.get(m.method) ?? []);
  return indexes.length > 0 ? indexes : undefined;
}

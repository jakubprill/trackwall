import {
  type EndpointCaller,
  type FindEndpointResult,
  type FoundEndpoint,
  type HttpMethod,
  httpMethodMatches,
  httpPathMatches,
  MAX_FOUND_ENDPOINTS,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { compare, push } from "./graph-join.ts";
import type { HttpIndex } from "./http-index.ts";

/**
 * Endpoint search (§4.6, §5.3, ADR-30): endpoints from the cards of all repos matching the query, and the repos whose
 * HTTP clients call them, with the same confidence as an `http` edge. A query starting with `/` is a path (also a concrete one,
 * `/api/orders/42` matches `/api/orders/{id}`) or a fragment of one; anything else is a fragment of a path, handler or app
 * name, case-insensitive. Each caller has the endpoints of its repo that reach the call, and each found endpoint the
 * endpoints of other repos it calls (ADR-82).
 */
export function findEndpoints(index: HttpIndex, query: string, method: HttpMethod | undefined): FindEndpointResult {
  const wanted = query.trim();
  const found = index.endpoints
    .filter(({ endpoint }) => httpMethodMatches(method ?? null, endpoint.method) && matchesQuery(endpoint, wanted))
    .sort((a, b) => compare(a.repo, b.repo) || compare(a.endpoint.path, b.endpoint.path));
  const shown = found.slice(0, MAX_FOUND_ENDPOINTS);
  const calls = new EndpointCalls(index);
  const callers = callersByEndpoint(index, calls, new Set(shown.map((e) => e.endpoint)));
  const endpoints: FoundEndpoint[] = shown.map(({ repo, endpoint }) => ({
    repo,
    app: endpoint.app,
    method: endpoint.method,
    path: endpoint.path,
    handler: endpoint.handler,
    request: endpoint.request,
    response: endpoint.response,
    evidence: endpoint.evidence,
    callers: callers.get(endpoint) ?? [],
    calls: calls.calls(repo, endpoint),
  }));
  return { query: wanted, endpoints, truncated: found.length > shown.length };
}

function matchesQuery(endpoint: ProvidedEndpoint, query: string): boolean {
  const lower = query.toLowerCase();
  if (query.startsWith("/") && httpPathMatches(query, endpoint.path)) return true;
  return [endpoint.path, endpoint.handler, endpoint.app ?? ""].some((text) => text.toLowerCase().includes(lower));
}

/** The calls of the clients of all repos assigned to endpoints from `wanted` through the clients' targets (`HttpIndex.targets`). */
function callersByEndpoint(
  index: HttpIndex,
  calls: EndpointCalls,
  wanted: ReadonlySet<ProvidedEndpoint>,
): Map<ProvidedEndpoint, EndpointCaller[]> {
  const callers = new Map<ProvidedEndpoint, EndpointCaller[]>();
  if (wanted.size === 0) return callers;
  for (const { repo, client } of index.clients)
    for (const target of index.targets(repo, client))
      for (const m of target.calls) {
        if (!wanted.has(m.endpoint)) continue;
        const caller: EndpointCaller = {
          repo,
          via: client.via,
          client: client.name,
          method: m.call.method,
          path: m.path,
          confidence: target.confidence,
          evidence: m.call.evidence,
          from: calls.from(repo, client, m.call),
        };
        push(callers, m.endpoint, caller);
      }
  return callers;
}

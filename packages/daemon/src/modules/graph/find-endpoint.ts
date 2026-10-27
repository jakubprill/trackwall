import {
  type EndpointCaller,
  type FindEndpointResult,
  type FoundEndpoint,
  type HttpMethod,
  httpMethodMatches,
  MAX_FOUND_ENDPOINTS,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { MATCH_ORDER, matchEndpoint, parseEndpointQuery } from "./endpoint-query.ts";
import { compare, push } from "./graph-join.ts";
import type { HttpIndex } from "./http-index.ts";

/**
 * Endpoint search (§4.6, §5.3, ADR-30, ADR-87): endpoints from the cards of all repos matching the query
 * (`endpoint-query.ts`), best match first, and the repos whose HTTP clients call them, with the same confidence as an
 * `http` edge. Each caller has the endpoints of its repo that reach the call, and each found endpoint the endpoints of
 * other repos it calls (ADR-82).
 */
export function findEndpoints(index: HttpIndex, query: string, method: HttpMethod | undefined): FindEndpointResult {
  const wanted = query.trim();
  const parsed = parseEndpointQuery(wanted);
  const methodWanted = method ?? parsed.method ?? null;
  const found = index.endpoints
    .flatMap((e) => {
      const match = httpMethodMatches(methodWanted, e.endpoint.method) ? matchEndpoint(parsed, e.endpoint, e.segments) : undefined;
      return match === undefined ? [] : [{ ...e, match }];
    })
    .sort(
      (a, b) =>
        MATCH_ORDER.indexOf(a.match) - MATCH_ORDER.indexOf(b.match) || compare(a.repo, b.repo) || compare(a.endpoint.path, b.endpoint.path),
    );
  const shown = found.slice(0, MAX_FOUND_ENDPOINTS);
  const calls = new EndpointCalls(index);
  const callers = callersByEndpoint(index, calls, new Set(shown.map((e) => e.endpoint)));
  const endpoints: FoundEndpoint[] = shown.map(({ repo, endpoint, match }) => ({
    repo,
    match,
    app: endpoint.app,
    method: endpoint.method,
    path: endpoint.path,
    handler: endpoint.handler,
    source: endpoint.source,
    operation: endpoint.operation,
    request: endpoint.request,
    response: endpoint.response,
    evidence: endpoint.evidence,
    callers: callers.get(endpoint) ?? [],
    calls: calls.calls(repo, endpoint),
  }));
  return { query: wanted, endpoints, truncated: found.length > shown.length };
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

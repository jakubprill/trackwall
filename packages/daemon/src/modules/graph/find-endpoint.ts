import {
  type ConsumedHttp,
  type EndpointCaller,
  type FindEndpointResult,
  type FoundEndpoint,
  type HttpCall,
  type HttpMethod,
  httpMethodMatches,
  MAX_FOUND_ENDPOINTS,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { MATCH_ORDER, matchEndpoint, parseEndpointQuery } from "./endpoint-query.ts";
import { compare, push, strongerConfidence } from "./graph-join.ts";
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
export function callersByEndpoint(
  index: HttpIndex,
  calls: EndpointCalls,
  wanted: ReadonlySet<ProvidedEndpoint>,
): Map<ProvidedEndpoint, EndpointCaller[]> {
  const callers = new Map<ProvidedEndpoint, EndpointCaller[]>();
  if (wanted.size === 0) return callers;
  for (const { repo, client } of index.clients)
    for (const [endpoint, caller] of clientCallers(index, calls, wanted, repo, client)) push(callers, endpoint, caller);
  return callers;
}

/**
 * One client's calls with the endpoints from `wanted` they reach. A client can reach a repo through two targets (a
 * spec's title naming both its app and the repo, two apps of one name), so each call–endpoint pair comes once, with the
 * surer confidence, as the client's `http` edge does (`EdgeSet`).
 */
function clientCallers(
  index: HttpIndex,
  calls: EndpointCalls,
  wanted: ReadonlySet<ProvidedEndpoint>,
  repo: string,
  client: ConsumedHttp,
): [ProvidedEndpoint, EndpointCaller][] {
  const pairs = new Map<HttpCall, Map<ProvidedEndpoint, EndpointCaller>>();
  for (const target of index.targets(repo, client))
    for (const m of target.calls) {
      if (!wanted.has(m.endpoint)) continue;
      const ofCall = pairs.get(m.call) ?? new Map<ProvidedEndpoint, EndpointCaller>();
      pairs.set(m.call, ofCall);
      const known = ofCall.get(m.endpoint);
      if (known) known.confidence = strongerConfidence(known.confidence, target.confidence);
      else
        ofCall.set(m.endpoint, {
          repo,
          via: client.via,
          client: client.name,
          method: m.call.method,
          path: m.path,
          confidence: target.confidence,
          evidence: m.call.evidence,
          from: calls.from(repo, client, m.call),
        });
    }
  return [...pairs.values()].flatMap((ofCall) => [...ofCall]);
}

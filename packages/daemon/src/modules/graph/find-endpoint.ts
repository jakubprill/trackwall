import {
  type EndpointCaller,
  type FindEndpointResult,
  type FoundEndpoint,
  type HttpMethod,
  httpPathMatches,
  MAX_FOUND_ENDPOINTS,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { compare } from "./graph-join.ts";
import type { HttpIndex } from "./http-index.ts";

/**
 * Wyszukiwanie endpointów (§4.6, §5.3, ADR-30): endpointy z kart wszystkich repo pasujące do zapytania i repo, których
 * klienci HTTP je wołają, z tą samą pewnością co krawędź `http`. Zapytanie od `/` to ścieżka (także konkretna,
 * `/api/orders/42` pasuje do `/api/orders/{id}`) albo jej fragment; inne to fragment ścieżki, handlera albo nazwy
 * aplikacji, bez wielkości liter.
 */
export function findEndpoints(index: HttpIndex, query: string, method: HttpMethod | undefined): FindEndpointResult {
  const wanted = query.trim();
  const found = index.endpoints
    .filter(({ endpoint }) => (method === undefined || endpoint.method === null || endpoint.method === method) && matchesQuery(endpoint, wanted))
    .sort((a, b) => compare(a.repo, b.repo) || compare(a.endpoint.path, b.endpoint.path));
  const shown = found.slice(0, MAX_FOUND_ENDPOINTS);
  const callers = callersByEndpoint(index, new Set(shown.map((e) => e.endpoint)));
  const endpoints: FoundEndpoint[] = shown.map(({ repo, endpoint }) => ({
    repo,
    app: endpoint.app,
    method: endpoint.method,
    path: endpoint.path,
    handler: endpoint.handler,
    evidence: endpoint.evidence,
    callers: callers.get(endpoint) ?? [],
  }));
  return { query: wanted, endpoints, truncated: found.length > shown.length };
}

function matchesQuery(endpoint: ProvidedEndpoint, query: string): boolean {
  const lower = query.toLowerCase();
  if (query.startsWith("/") && httpPathMatches(query, endpoint.path)) return true;
  return [endpoint.path, endpoint.handler, endpoint.app ?? ""].some((text) => text.toLowerCase().includes(lower));
}

/** Wywołania klientów wszystkich repo przypisane do endpointów z `wanted` przez cele klientów (`HttpIndex.targets`). */
function callersByEndpoint(index: HttpIndex, wanted: ReadonlySet<ProvidedEndpoint>): Map<ProvidedEndpoint, EndpointCaller[]> {
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
        };
        callers.set(m.endpoint, [...(callers.get(m.endpoint) ?? []), caller]);
      }
  return callers;
}

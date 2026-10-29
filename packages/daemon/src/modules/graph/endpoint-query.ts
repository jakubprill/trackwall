import {
  type EndpointMatch,
  HttpMethod,
  httpPathSegments,
  httpSegmentsMatch,
  httpUrlPath,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { isLiteral } from "./path-segment.ts";

/**
 * The `find_endpoint` query (§5.3, ADR-30, ADR-87) as an agent writes it: a path (`/api/orders/42`, also without the
 * leading `/`), a whole address (`https://host/orders-api/api/orders/42?x=1`), a method in front (`GET /api/orders`), or
 * words (`cancel order`, `OrdersController`). A path matches the whole endpoint path or its end, because the agent often
 * knows the path without the context path or with a gateway prefix in front; words match the path, handler, app and
 * OpenAPI operation.
 */

export interface EndpointQuery {
  /** The method written in front of the path; `find_endpoint`'s `method` argument wins over it. */
  method: HttpMethod | undefined;
  /** The path's segments when the query is a path or an address. */
  segments: string[] | undefined;
  /** The query in lowercase, split into words. */
  words: string[];
}

/** The order of the match kinds, best first; results are sorted by it. */
export const MATCH_ORDER: readonly EndpointMatch[] = ["path", "path-end", "text"];

export function parseEndpointQuery(text: string): EndpointQuery {
  const parts = text.trim().split(/\s+/);
  // A method only in front of a path or address: in words (`get order status`) "get" is a word, not a filter.
  const [first = "", second = ""] = parts;
  const method = parts.length === 2 && second.includes("/") ? HttpMethod.safeParse(first.toUpperCase()).data : undefined;
  const rest = method === undefined ? parts : parts.slice(1);
  const only = rest.length === 1 ? (rest[0] ?? "") : "";
  const path = httpUrlPath(only);
  const isPath = only.includes("/") && path !== "";
  return {
    method,
    segments: isPath ? httpPathSegments(path) : undefined,
    words: rest.map((w) => w.toLowerCase()).filter((w) => w !== ""),
  };
}

/** How the endpoint matches the query; `undefined` when it does not. */
export function matchEndpoint(query: EndpointQuery, endpoint: ProvidedEndpoint, segments: readonly string[]): EndpointMatch | undefined {
  if (query.segments !== undefined) {
    if (httpSegmentsMatch(query.segments, segments)) return "path";
    if (endsAlike(query.segments, segments)) return "path-end";
  }
  const texts = [endpoint.path, endpoint.handler, endpoint.app, endpoint.operation?.id, endpoint.operation?.summary]
    .filter((t) => t !== null && t !== undefined)
    .map((t) => t.toLowerCase());
  return query.words.length > 0 && query.words.every((w) => texts.some((t) => t.includes(w))) ? "text" : undefined;
}

/**
 * Whether the shorter path is the end of the longer one, with at least one fixed segment equal on both sides: `/42` alone
 * would match every endpoint ending in `{id}`. An endpoint with `**` matches only as a whole path.
 */
function endsAlike(query: readonly string[], endpoint: readonly string[]): boolean {
  if (query.length === endpoint.length || endpoint.includes("**")) return false;
  const length = Math.min(query.length, endpoint.length);
  const a = query.slice(-length);
  const b = endpoint.slice(-length);
  return httpSegmentsMatch(a, b) && a.some((s, i) => s === b[i] && isLiteral(s));
}

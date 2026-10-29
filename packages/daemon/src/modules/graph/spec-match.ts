import { type HttpCall, httpMethodMatches, httpSegmentsMatch, type ProvidedEndpoint } from "@trackwall/protocol";
import { push } from "./graph-join.ts";
import { isLiteral } from "./path-segment.ts";

/**
 * Matching the calls of an OpenAPI spec client (§4.6, ADR-129) with the endpoints of one repo. A spec the frontend keeps
 * is the backend's spec after a tool has normalised it: the operations and their `operationId`s stay, but the paths may
 * get another prefix (a gateway, a context path, a bundler's prefix). So a call matches an endpoint with the same
 * method by `operationId` (when the endpoint's spec gives one), or by path with its prefix swapped: the two paths end
 * alike, with a fixed segment equal on both sides, and what is in front of that end differs. One spec has one prefix
 * swap, the one most calls share, so a call matching some other endpoint by its last segments alone does not count.
 */

/** The share of a spec's calls a repo must serve to be the spec's target by its operations alone. */
export const MIN_SPEC_COVERAGE = 0.5;

/** A call with its full path (the client's base path and the call path) and that path's segments. */
export interface SpecCall {
  call: HttpCall;
  path: string;
  segments: readonly string[];
}

export interface SpecEndpoint {
  endpoint: ProvidedEndpoint;
  segments: readonly string[];
}

export interface SpecMatch {
  call: SpecCall;
  endpoint: ProvidedEndpoint;
  /** By `operationId` or by the same path; otherwise by the path with its prefix swapped. */
  exact: boolean;
}

/** How well a repo serves a spec: the share of its calls with a match, and with an exact one. */
export interface SpecCoverage {
  any: number;
  exact: number;
}

/** The swap key of a path matching as a whole: nothing in front on either side. */
const NO_SWAP = JSON.stringify([[], []]);

/** The spec calls with every endpoint they match, in the order of the calls. */
export function matchSpecCalls(calls: readonly SpecCall[], endpoints: readonly SpecEndpoint[]): SpecMatch[] {
  const byCall = new Map<SpecCall, SpecMatch[]>();
  const bySwap = new Map<string, SpecMatch[]>();
  for (const call of calls)
    for (const e of endpoints) {
      const found = matchOne(call, e);
      if (found?.swap === undefined) {
        if (found) push(byCall, call, found.match);
      } else push(bySwap, found.swap, found.match);
    }
  for (const m of mostCalls(bySwap)) push(byCall, m.call, m);
  return calls.flatMap((call) => byCall.get(call) ?? []);
}

/** How a call matches an endpoint: by `operationId` (without a swap), by path with a prefix swap, or not at all. */
function matchOne(call: SpecCall, e: SpecEndpoint): { match: SpecMatch; swap: string | undefined } | undefined {
  const endpoint = e.endpoint;
  if (!httpMethodMatches(call.call.method, endpoint.method)) return undefined;
  if (call.call.operationId !== null && endpoint.operation?.id === call.call.operationId)
    return { match: { call, endpoint, exact: true }, swap: undefined };
  const swap = prefixSwap(call.segments, e.segments);
  return swap === undefined ? undefined : { match: { call, endpoint, exact: swap === NO_SWAP }, swap };
}

/** The share of `calls` with at least one match, and with an exact one. */
export function specCoverage(calls: readonly SpecCall[], matches: readonly SpecMatch[]): SpecCoverage {
  if (calls.length === 0) return { any: 0, exact: 0 };
  const share = (list: readonly SpecMatch[]) => new Set(list.map((m) => m.call)).size / calls.length;
  return { any: share(matches), exact: share(matches.filter((m) => m.exact)) };
}

/**
 * The prefix swap that turns the call path into the endpoint path (`api/v1 → orders-bff`), as a key; `undefined` when
 * the paths do not end alike with a fixed segment equal on both sides. The end is as long as the segments match
 * (a variable on either side matches any segment), and the rest of each path is its prefix. An endpoint with `**`
 * forwards a whole subtree (a gateway route, a SPA), which is not an operation of the spec.
 */
function prefixSwap(call: readonly string[], endpoint: readonly string[]): string | undefined {
  if (endpoint.includes("**")) return undefined;
  let end = 0;
  let fixed = false;
  while (end < call.length && end < endpoint.length) {
    const a = call[call.length - 1 - end] ?? "";
    const b = endpoint[endpoint.length - 1 - end] ?? "";
    if (!httpSegmentsMatch([a], [b])) break;
    if (a === b && isLiteral(a)) fixed = true;
    end++;
  }
  if (!fixed) return undefined;
  return JSON.stringify([call.slice(0, call.length - end), endpoint.slice(0, endpoint.length - end)]);
}

/** The matches of the swap that the most calls share; the first such swap on a tie. */
function mostCalls(bySwap: ReadonlyMap<string, SpecMatch[]>): SpecMatch[] {
  let best: SpecMatch[] = [];
  let count = 0;
  for (const matches of bySwap.values()) {
    const calls = new Set(matches.map((m) => m.call)).size;
    if (calls > count) [best, count] = [matches, calls];
  }
  return best;
}

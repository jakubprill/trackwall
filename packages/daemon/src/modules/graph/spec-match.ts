import { type HttpCall, httpMethodMatches, type ProvidedEndpoint } from "@trackwall/protocol";
import { push } from "./graph-join.ts";
import { isLiteral } from "./path-segment.ts";

/**
 * Matching the calls of an OpenAPI spec client (§4.6, ADR-129) with the endpoints of other repos. A spec the frontend
 * keeps is the backend's spec after a tool has normalised it: the operations and their `operationId`s stay, but the
 * paths may get another prefix (a gateway, a context path, a bundler's prefix). So a call matches an endpoint with the
 * same method by `operationId` (when the endpoint's spec gives one) if the endpoint's path holds the call's last fixed
 * segment (ids like `getById` repeat across services, so the id alone is not enough), or by path with its prefix
 * swapped: the paths end alike (the same fixed segments, variables where the other has one) up to and including the
 * call's last fixed segment (`orders` in `/v1/orders/{id}`), and what is in front of that end differs. A call is
 * compared with the endpoints of each repo that end most like it, and one spec has one prefix swap, the one most calls
 * share, so a call whose last segments alone are like some endpoint's does not count.
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
  repo: string;
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

/** The candidates of each call in one repo. */
export type SpecCandidates = ReadonlyMap<SpecCall, readonly SpecEndpoint[]>;

/** The swap key of a path matching as a whole: nothing in front on either side. */
const NO_SWAP = "→";

/**
 * Endpoints by the end of their path and by `operationId`, so that a call is compared only with the endpoints that can
 * match it: a common last segment (`status`, `items`) would otherwise compare every call with thousands of endpoints.
 */
export class SpecEndpointIndex {
  private readonly byEnd = new Map<string, SpecEndpoint[]>();
  private readonly byOperation = new Map<string, SpecEndpoint[]>();

  /** An endpoint with a fixed segment; one with `**` forwards a whole subtree (a gateway route, a SPA), not an operation. */
  add(e: SpecEndpoint): void {
    if (e.segments.includes("**")) return;
    const id = e.endpoint.operation?.id;
    if (id) push(this.byOperation, id, e);
    for (let length = 1; length <= e.segments.length; length++) push(this.byEnd, endKey(e.segments, length), e);
  }

  /**
   * Each call's candidates, by repo: the endpoints whose path ends the longest way like the call's (at least up to its last
   * fixed segment), and those with its `operationId`. The longest way in the whole workspace, not in each repo: in a repo
   * that has only `{}/status` like `/orders/{id}/status`, the call's resource is not there.
   */
  candidates(calls: readonly SpecCall[]): Map<string, Map<SpecCall, SpecEndpoint[]>> {
    const byRepo = new Map<string, Map<SpecCall, SpecEndpoint[]>>();
    for (const call of calls) {
      const id = call.call.operationId;
      const byId = id ? (this.byOperation.get(id) ?? []) : [];
      for (const e of new Set([...this.longestEnd(call.segments), ...byId])) {
        const ofRepo = byRepo.get(e.repo) ?? new Map<SpecCall, SpecEndpoint[]>();
        byRepo.set(e.repo, ofRepo);
        push(ofRepo, call, e);
      }
    }
    return byRepo;
  }

  private longestEnd(segments: readonly string[]): readonly SpecEndpoint[] {
    const shortest = shortestEnd(segments);
    for (let length = segments.length; length >= shortest && shortest > 0; length--) {
      const found = this.byEnd.get(endKey(segments, length));
      if (found) return found;
    }
    return [];
  }
}

/** The spec calls with every endpoint they match among their candidates in one repo, in the order of the calls. */
export function matchSpecCalls(calls: readonly SpecCall[], candidates: SpecCandidates): SpecMatch[] {
  const byCall = new Map<SpecCall, SpecMatch[]>();
  const bySwap = new Map<string, SpecMatch[]>();
  for (const call of calls)
    for (const e of candidates.get(call) ?? []) {
      if (!httpMethodMatches(call.call.method, e.endpoint.method)) continue;
      const swap = prefixSwap(call.segments, e.segments);
      if (call.call.operationId !== null && e.endpoint.operation?.id === call.call.operationId && holdsLastFixed(call, e))
        push(byCall, call, { call, endpoint: e.endpoint, exact: true });
      else if (swap !== undefined) push(bySwap, swap, { call, endpoint: e.endpoint, exact: swap === NO_SWAP });
    }
  for (const m of mostCalls(bySwap)) push(byCall, m.call, m);
  return calls.flatMap((call) => byCall.get(call) ?? []);
}

/** The share of `calls` with at least one match, and with an exact one. */
export function specCoverage(calls: readonly SpecCall[], matches: readonly SpecMatch[]): SpecCoverage {
  if (calls.length === 0) return { any: 0, exact: 0 };
  const share = (list: readonly SpecMatch[]) => new Set(list.map((m) => m.call)).size / calls.length;
  return { any: share(matches), exact: share(matches.filter((m) => m.exact)) };
}

/**
 * The last `length` segments, with every variable as `{}`: two paths end alike over `length` segments when the keys are
 * equal.
 */
function endKey(segments: readonly string[], length: number): string {
  return segments
    .slice(segments.length - length)
    .map((s) => (isLiteral(s) ? s : "{}"))
    .join("/");
}

/** How many segments from the end hold the last fixed segment; `0` for a path without one, which matches nothing. */
function shortestEnd(segments: readonly string[]): number {
  const last = segments.findLastIndex(isLiteral);
  return last < 0 ? 0 : segments.length - last;
}

function holdsLastFixed(call: SpecCall, e: SpecEndpoint): boolean {
  const last = call.segments.findLast(isLiteral);
  return last !== undefined && e.segments.includes(last);
}

/**
 * The prefix swap that turns the call path into the endpoint path (`api/v1→orders-bff`), as a key; `undefined` when the
 * paths do not end alike up to the call's last fixed segment. The rest of each path in front of the end is its prefix.
 */
function prefixSwap(call: readonly string[], endpoint: readonly string[]): string | undefined {
  let end = 0;
  while (
    end < call.length &&
    end < endpoint.length &&
    sameKind(call[call.length - 1 - end] ?? "", endpoint[endpoint.length - 1 - end] ?? "")
  )
    end++;
  const shortest = shortestEnd(call);
  if (shortest === 0 || end < shortest) return undefined;
  return `${call.slice(0, call.length - end).join("/")}→${endpoint.slice(0, endpoint.length - end).join("/")}`;
}

/** The same fixed segment, or a variable on both sides (`{id}` and `{orderId}`), as `endKey` compares them. */
function sameKind(a: string, b: string): boolean {
  return isLiteral(a) ? a === b : !isLiteral(b);
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

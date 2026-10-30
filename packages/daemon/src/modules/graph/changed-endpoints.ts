import {
  type ChangedEndpoint,
  type EndpointCaller,
  type EndpointChange,
  type ImpactedRepo,
  MAX_CHANGED_ENDPOINTS,
  type ProvidedEndpoint,
} from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { callersByEndpoint } from "./find-endpoint.ts";
import type { HttpIndex } from "./http-index.ts";
import { impactOf } from "./impact.ts";

/**
 * The callers of the endpoints a task's commits remove or change (ADR-145): the clients that call the endpoint of the
 * same repo, app, method and path in the graph (all of them, when several share these), which is built from every repo
 * root's HEAD, usually the task's base, and the repos they reach through those callers (`impact`, ADR-147).
 * An added endpoint has no caller yet. At most `MAX_CHANGED_ENDPOINTS` changes.
 */
export function withCallers(
  index: HttpIndex,
  repo: string,
  changes: readonly EndpointChange[],
): { endpoints: ChangedEndpoint[]; truncated: boolean; impact: ImpactedRepo[] } {
  const shown = changes.slice(0, MAX_CHANGED_ENDPOINTS);
  const inGraph = new Map<EndpointChange, ProvidedEndpoint[]>();
  for (const change of shown)
    if (change.change !== "added")
      inGraph.set(
        change,
        index.endpoints
          .filter(
            (e) =>
              e.repo === repo && e.endpoint.app === change.app && e.endpoint.method === change.method && e.endpoint.path === change.path,
          )
          .map((e) => e.endpoint),
      );
  const calls = new EndpointCalls(index);
  const changed = new Set([...inGraph.values()].flat());
  const callers = callersByEndpoint(index, calls, changed);
  const endpoints = shown.map((change) => ({
    ...change,
    callers: distinct((inGraph.get(change) ?? []).flatMap((endpoint) => callers.get(endpoint) ?? [])),
  }));
  return { endpoints, truncated: changes.length > shown.length, impact: impactOf(index, calls, repo, changed) };
}

/** A call matches each endpoint that shares its place, so with several there it would be listed once per endpoint. */
function distinct(callers: EndpointCaller[]): EndpointCaller[] {
  const seen = new Set<string>();
  return callers.filter((c) => {
    const key = JSON.stringify([c.repo, c.client, c.method, c.path, c.evidence.path, c.evidence.line]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

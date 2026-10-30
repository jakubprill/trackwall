import { type ChangedEndpoint, type EndpointChange, MAX_CHANGED_ENDPOINTS, type ProvidedEndpoint } from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { callersByEndpoint } from "./find-endpoint.ts";
import type { HttpIndex } from "./http-index.ts";

/**
 * The callers of the endpoints a task's commits remove or change (ADR-145): the clients that call the endpoint of the
 * same repo, app, method and path in the graph (all of them, when several share these), which is built from every repo
 * root's HEAD, usually the task's base.
 * An added endpoint has no caller yet. At most `MAX_CHANGED_ENDPOINTS` changes.
 */
export function withCallers(
  index: HttpIndex,
  repo: string,
  changes: readonly EndpointChange[],
): { endpoints: ChangedEndpoint[]; truncated: boolean } {
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
  const callers = callersByEndpoint(index, new EndpointCalls(index), new Set([...inGraph.values()].flat()));
  const endpoints = shown.map((change) => ({
    ...change,
    callers: (inGraph.get(change) ?? []).flatMap((endpoint) => callers.get(endpoint) ?? []),
  }));
  return { endpoints, truncated: changes.length > shown.length };
}

import { type ChangedEndpoint, MAX_CHANGED_ENDPOINTS, type ProvidedEndpoint } from "@trackwall/protocol";
import { EndpointCalls } from "./endpoint-calls.ts";
import { callersByEndpoint } from "./find-endpoint.ts";
import type { HttpIndex } from "./http-index.ts";

/** An endpoint change from `cards` (ADR-145), without its callers. */
type EndpointChange = Omit<ChangedEndpoint, "callers">;

/**
 * The callers of the endpoints a task's commits remove or change (ADR-145): the clients that call the endpoint of the
 * same repo, app, method and path in the graph, which is built from every repo's HEAD, so the task's base in practice.
 * An added endpoint has no caller yet. At most `MAX_CHANGED_ENDPOINTS` changes.
 */
export function withCallers(
  index: HttpIndex,
  repo: string,
  changes: readonly EndpointChange[],
): { endpoints: ChangedEndpoint[]; truncated: boolean } {
  const shown = changes.slice(0, MAX_CHANGED_ENDPOINTS);
  const inGraph = new Map<EndpointChange, ProvidedEndpoint>();
  for (const change of shown) {
    if (change.change === "added") continue;
    const found = index.endpoints.find(
      (e) => e.repo === repo && e.endpoint.app === change.app && e.endpoint.method === change.method && e.endpoint.path === change.path,
    );
    if (found) inGraph.set(change, found.endpoint);
  }
  const callers = callersByEndpoint(index, new EndpointCalls(index), new Set(inGraph.values()));
  const endpoints = shown.map((change) => {
    const endpoint = inGraph.get(change);
    return { ...change, callers: endpoint === undefined ? [] : (callers.get(endpoint) ?? []) };
  });
  return { endpoints, truncated: changes.length > shown.length };
}

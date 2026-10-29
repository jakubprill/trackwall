import { type ConsumedHttp, type GraphProblem, parseHttpUrl } from "@trackwall/protocol";
import { type HttpIndex, isLocalHost } from "./http-index.ts";
import { MIN_SPEC_COVERAGE } from "./spec-match.ts";

/**
 * The `unresolved-call-target` graph problem (§4.6, ADR-116): an HTTP client that the code uses (it has calls, or an app
 * name such as Feign's `name`) and that points to no repo in the list. It is a gap only the whole graph can see, so it
 * is not on the card. It is either an external system or an app the graph needs a `graph.apps` alias for; the message
 * says which entry would help. An address in the configuration with no known call and no name (a Zipkin or database
 * address) is not a call, so it gives no problem.
 */
export function unresolvedCalls(index: HttpIndex): GraphProblem[] {
  return index.clients.flatMap(({ repo, client }) => {
    if (!isCall(client)) return [];
    const { targets, ownRepo } = index.resolve(repo, client);
    if (targets.length > 0 || ownRepo) return [];
    return [
      { code: "unresolved-call-target", repo, via: client.via, client: client.name, evidence: client.evidence, message: message(client) },
    ];
  });
}

function isCall(client: ConsumedHttp): boolean {
  // A spec a script downloads from a local port is a call to one of the user's apps; from elsewhere, a public API maybe.
  return client.calls.length > 0 || client.app !== null || (client.via === "openapi" && isLocalUrl(client.url));
}

/** What the graph looked for, and the entry that would connect it: an alias by name or host, or an app's port for `localhost`. */
function message(client: ConsumedHttp): string {
  // A spec's server address is often a gateway's, so an alias for its host would send every spec behind it to one repo.
  if (client.via === "openapi" && client.calls.length === 0 && client.url !== null)
    return `no app in the list serves the spec ${client.name} downloads from ${client.url}; its host or localhost port names none`;
  if (client.via === "openapi")
    return `no repo in the list serves ${MIN_SPEC_COVERAGE * 100}% of the operations of ${client.name} (by operationId, or by path with another prefix)`;
  const url = client.url === null ? undefined : parseHttpUrl(client.url);
  const name = client.app ?? (url !== undefined && !isLocalHost(url.host) ? url.host : undefined);
  if (name !== undefined)
    return `no repo in the list is “${name}”; if it is one of yours, map it to its repo under graph.apps in workspace.yaml`;
  if (url?.port != null) return `no app in the list runs on ${url.host}:${url.port} (server.port on its card)`;
  return `no repo in the list has an endpoint matching the calls of ${client.name}`;
}

function isLocalUrl(url: string | null): boolean {
  const parsed = url === null ? undefined : parseHttpUrl(url);
  return parsed !== undefined && isLocalHost(parsed.host);
}

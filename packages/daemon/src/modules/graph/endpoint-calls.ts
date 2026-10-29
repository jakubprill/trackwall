import type { ConsumedHttp, EndpointCallee, EndpointRef, Evidence, HttpCall, ProvidedEndpoint } from "@trackwall/protocol";
import { push } from "./graph-join.ts";
import type { HttpIndex, RepoClient } from "./http-index.ts";

/**
 * Calls between endpoints (§4.6, §5.3, ADR-82), from the reach on the cards (which client calls an endpoint's handler
 * reaches) and the matches of `HttpIndex` (which endpoint of another repo a client call goes to): for a client call, the
 * endpoints of its own repo that reach it; for an endpoint, the endpoints of other repos it calls.
 */
export class EndpointCalls {
  private readonly index: HttpIndex;
  /** The endpoints that reach a client call, by `callKey`. */
  private readonly reachers = new Map<string, EndpointRef[]>();
  private readonly clients = new Map<string, RepoClient[]>();

  constructor(index: HttpIndex) {
    this.index = index;
    for (const { repo, endpoint } of index.endpoints) {
      // A mapping with two methods or paths is several reaches on one line, which is one key.
      const keys = new Set((endpoint.reaches ?? []).map((reach) => callKey(repo, reach.client, reach.evidence)));
      for (const key of keys) push(this.reachers, key, refOf(endpoint));
    }
    for (const client of index.clients) push(this.clients, client.repo, client);
  }

  /**
   * The endpoints of `repo` whose handlers reach this call of `client`; `null` when the repo's card could not trace, and
   * for a client from a spec, whose generated code is not in the repo, so no reach can lead to it (ADR-129).
   */
  from(repo: string, client: ConsumedHttp, call: HttpCall): EndpointRef[] | null {
    if (!this.index.reachTraced.has(repo) || client.via === "openapi") return null;
    return this.reachers.get(callKey(repo, client.name, call.evidence)) ?? [];
  }

  /** The endpoints of other repos that `endpoint` of `repo` calls; `null` when its card could not trace. */
  calls(repo: string, endpoint: ProvidedEndpoint): EndpointCallee[] | null {
    if (endpoint.reaches === null) return null;
    const reached = new Set(endpoint.reaches.map((r) => callKey(repo, r.client, r.evidence)));
    // A client split by profile is in the index once per address, and two addresses can lead to the same repo.
    const callees = new Map<string, EndpointCallee>();
    for (const { client } of reached.size > 0 ? (this.clients.get(repo) ?? []) : [])
      for (const callee of this.calleesOf(repo, client, reached)) {
        const key = JSON.stringify([callee.repo, callee.method, callee.path, callee.handler, callee.client, callee.evidence]);
        if (!callees.has(key)) callees.set(key, callee);
      }
    return [...callees.values()];
  }

  /** The endpoints the `reached` calls of one client of `repo` go to. */
  private *calleesOf(repo: string, client: ConsumedHttp, reached: ReadonlySet<string>): Generator<EndpointCallee> {
    for (const target of this.index.targets(repo, client))
      for (const m of target.calls)
        if (reached.has(callKey(repo, client.name, m.call.evidence)))
          yield {
            ...refOf(m.endpoint),
            repo: target.repo,
            via: client.via,
            client: client.name,
            confidence: target.confidence,
            evidence: m.call.evidence,
          };
  }
}

function refOf(endpoint: ProvidedEndpoint): EndpointRef {
  return { method: endpoint.method, path: endpoint.path, handler: endpoint.handler };
}

/** A client call within a repo: the client's name and the call's file and line (the same call on the card and in a reach). */
function callKey(repo: string, client: string, evidence: Evidence): string {
  return JSON.stringify([repo, client, evidence.path, evidence.line]);
}

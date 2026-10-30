import { type EndpointRef, type ImpactCall, type ImpactedRepo, MAX_IMPACT_RINGS, type ProvidedEndpoint } from "@trackwall/protocol";
import type { EndpointCalls } from "./endpoint-calls.ts";
import { callersByEndpoint } from "./find-endpoint.ts";
import type { HttpIndex } from "./http-index.ts";

/**
 * The impact of a change (§4.6, ADR-147): the repos whose clients call the changed endpoints (ring 1), then the repos
 * that call an endpoint of ring 1 whose handler reaches such a call (ring 2), up to `MAX_IMPACT_RINGS`. It walks the
 * same matches and reaches as `find_endpoint` (ADR-82). Two things make a repo only maybe reached (`sure: false`): a
 * repo before it whose card could not trace (`through: null`), from whose every endpoint the walk then goes on, and a
 * client with an address but no known paths (a frontend's proxy to its BFF), which may call any endpoint of its target.
 */
export function impactOf(index: HttpIndex, calls: EndpointCalls, repo: string, changed: ReadonlySet<ProvidedEndpoint>): ImpactedRepo[] {
  const repoOf = new Map(index.endpoints.map((e) => [e.endpoint, e.repo]));
  const reached = new Set([repo]);
  const impact: ImpactedRepo[] = [];
  /** The endpoints the next ring calls, each with whether the change surely reaches it. */
  let frontier = new Map([...changed].map((endpoint) => [endpoint, true]));
  /** The repos of the last ring whose change goes on, to which a client without paths may lead. */
  let carrying: string[] = [repo];
  for (let ring = 1; ring <= MAX_IMPACT_RINGS && carrying.length > 0; ring++) {
    const byEndpoint = ringOf(callersByEndpoint(index, calls, new Set(frontier.keys())), frontier, repoOf, reached);
    const byAddress = pathlessCallers(index, carrying, new Set([...reached, ...byEndpoint.map((r) => r.repo)]));
    const found = [...byEndpoint, ...byAddress].sort((a, b) => a.repo.localeCompare(b.repo));
    for (const r of found) reached.add(r.repo);
    impact.push(...found.map((r) => ({ ...r, ring })));
    frontier = new Map(found.flatMap((r) => endpointsOf(index, r).map((endpoint) => [endpoint, r.sure && r.through !== null] as const)));
    carrying = found.filter((r) => r.through === null || r.through.length > 0).map((r) => r.repo);
  }
  return impact;
}

/**
 * The repos with a client that points to one of `repos` by its address without a known path, so it may call the
 * endpoints the change goes on from; the client's own repo has no endpoint known to make that call either.
 */
function pathlessCallers(index: HttpIndex, repos: readonly string[], reached: ReadonlySet<string>): Omit<ImpactedRepo, "ring">[] {
  const into = new Set(repos);
  const uses = new Map<string, Set<string>>();
  for (const { repo, client } of index.clients) {
    if (reached.has(repo) || client.calls.length > 0) continue;
    for (const target of index.targets(repo, client))
      if (into.has(target.repo)) uses.set(repo, (uses.get(repo) ?? new Set()).add(target.repo));
  }
  return [...uses].map(([repo, used]) => ({ repo, uses: [...used], sure: false, calls: [], through: null }));
}

interface RingEntry {
  uses: Set<string>;
  calls: Map<string, ImpactCall>;
  through: Map<string, EndpointRef> | null;
  sure: boolean;
}

/** The repos of one ring, by name, each with the endpoints it calls and its own endpoints that make those calls. */
function ringOf(
  callers: ReadonlyMap<ProvidedEndpoint, readonly { repo: string; from: EndpointRef[] | null }[]>,
  frontier: ReadonlyMap<ProvidedEndpoint, boolean>,
  repoOf: ReadonlyMap<ProvidedEndpoint, string>,
  reached: ReadonlySet<string>,
): Omit<ImpactedRepo, "ring">[] {
  const ring = new Map<string, RingEntry>();
  for (const [endpoint, list] of callers)
    for (const caller of list) {
      if (reached.has(caller.repo)) continue;
      const entry = ring.get(caller.repo) ?? { uses: new Set<string>(), calls: new Map(), through: new Map(), sure: false };
      ring.set(caller.repo, entry);
      const call = { repo: ownerOf(repoOf, endpoint), method: endpoint.method, path: endpoint.path, handler: endpoint.handler };
      entry.uses.add(call.repo);
      entry.calls.set(refKey(call), call);
      // One sure path is enough for the repo to be surely reached.
      entry.sure ||= frontier.get(endpoint) === true;
      // One untraced call is enough not to know where the change goes on from this repo.
      if (caller.from === null) entry.through = null;
      else for (const ref of caller.from) entry.through?.set(refKey(ref), ref);
    }
  return [...ring].map(([repo, { uses, calls, through, sure }]) => ({
    repo,
    uses: [...uses],
    sure,
    calls: [...calls.values()],
    through: through === null ? null : [...through.values()],
  }));
}

function ownerOf(repoOf: ReadonlyMap<ProvidedEndpoint, string>, endpoint: ProvidedEndpoint): string {
  const owner = repoOf.get(endpoint);
  if (owner === undefined) throw new Error(`endpoint ${endpoint.path} of the impact is not in the graph's index`);
  return owner;
}

/** The endpoints of a ring's repo the change goes on from: those `through` names, or all of them when it is unknown. */
function endpointsOf(index: HttpIndex, { repo, through }: Omit<ImpactedRepo, "ring">): ProvidedEndpoint[] {
  const wanted = through === null ? null : new Set(through.map(refKey));
  return index.endpoints.filter((e) => e.repo === repo && (wanted === null || wanted.has(refKey(e.endpoint)))).map((e) => e.endpoint);
}

function refKey(ref: EndpointRef & { repo?: string }): string {
  return JSON.stringify([ref.repo ?? null, ref.method, ref.path, ref.handler]);
}

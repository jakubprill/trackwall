import {
  type ConsumedHttp,
  type EdgeConfidence,
  type EdgeEvidence,
  type HttpCall,
  type HttpUrl,
  httpMethodMatches,
  httpPathSegments,
  httpSegmentsMatch,
  joinHttpPath,
  type ProvidedApp,
  type ProvidedEndpoint,
  parseHttpUrl,
  type RepoCard,
} from "@trackwall/protocol";
import type { GraphCardInput } from "./graph-input.ts";
import { type Join, push } from "./graph-join.ts";

/**
 * Matching HTTP clients from the cards to apps and endpoints of other repos (§4.6, ADR-30), shared by the `http` edges
 * and `find_endpoint`. A client points to a repo by app name (Feign `name`, `lb://name`, a host equal to
 * `spring.application.name`), by an app alias from `workspace.yaml`, by a host equal to the repo name or by the app's port
 * on `localhost`; without any of them the graph looks for a repo whose endpoints match the call paths. Call paths
 * with matched endpoints are evidence and raise the confidence.
 */

/** How we know a client calls a repo; ordered from the most certain. */
type TargetBasis = "app" | "alias" | "repo-name" | "port" | "path";

/** A client call with the repo endpoint it matches. */
export interface MatchedCall {
  call: HttpCall;
  /** The full path: the path from the client's address and the call path. */
  path: string;
  endpoint: ProvidedEndpoint;
}

/** A repo the client calls, with the confidence, the edge key, the evidence on the target side and the matched calls. */
export interface HttpTarget {
  repo: string;
  basis: TargetBasis;
  confidence: EdgeConfidence;
  key: string;
  evidence: EdgeEvidence[];
  calls: MatchedCall[];
}

/**
 * Where a client points: its targets, and whether its name, alias or port points only to the client's own repo (an app
 * calling another app of the same repo), which is resolved although it gives no target.
 */
export interface HttpResolution {
  targets: HttpTarget[];
  ownRepo: boolean;
}

/** An HTTP client from a repo card. */
export interface RepoClient {
  repo: string;
  client: ConsumedHttp;
}

interface AppOf {
  repo: string;
  app: ProvidedApp;
}

/** An endpoint with its path segments computed once: the graph compares every call without a target with it. */
interface IndexedEndpoint {
  repo: string;
  endpoint: ProvidedEndpoint;
  segments: string[];
  /**
   * Whether the path has a fixed segment (`/api/**` yes, `/**` and `/{path}` no). An endpoint without one (forwarding everything
   * to a SPA) would match every call, so it is not evidence of a connection.
   */
  specific: boolean;
}

/** Hosts under which an app runs on a developer's computer; for them the port says what the target is. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"]);

export class HttpIndex {
  readonly clients: RepoClient[] = [];
  readonly endpoints: IndexedEndpoint[] = [];
  /**
   * Repos whose card traced the endpoint reach of every endpoint (ADR-82): only there does no endpoint reaching a call
   * mean that none makes it.
   */
  readonly reachTraced = new Set<string>();
  private readonly apps = new Map<string, AppOf[]>();
  private readonly ports = new Map<number, AppOf[]>();
  private readonly repoNames = new Map<string, string[]>();
  private readonly endpointsByRepo = new Map<string, IndexedEndpoint[]>();
  /** Endpoints by number of path segments, and those with `**` separately: a call is compared only with those that can match. */
  private readonly endpointsByLength = new Map<number, IndexedEndpoint[]>();
  /**
   * Endpoints by number of segments, position and the segment at it (`3/0/api`, with a variable `3/2/*`). A call is compared
   * only with endpoints that have its rarest fixed segment (or a variable) at the same position, so thousands
   * of endpoints in dozens of repos are not multiplied by every call (§8).
   */
  private readonly endpointsBySegment = new Map<string, IndexedEndpoint[]>();
  private readonly tailEndpoints: IndexedEndpoint[] = [];
  private readonly appAliases: Map<string, string>;
  private readonly resolveRef: (ref: string) => string[];
  /** Each client's resolution, computed once: the edges, the graph's problems and `find_endpoint` all ask for it. */
  private readonly resolutions = new WeakMap<ConsumedHttp, { from: string; resolution: HttpResolution }>();
  private readonly file: string;

  constructor(cards: readonly GraphCardInput[], join: Pick<Join, "appAliases" | "resolve" | "file">) {
    this.appAliases = join.appAliases;
    this.resolveRef = join.resolve;
    this.file = join.file;
    for (const entry of cards) if (entry.kind === "ok") this.addRepo(entry);
  }

  private addRepo(entry: Extract<GraphCardInput, { kind: "ok" }>): void {
    if (tracesEveryEndpoint(entry.card)) this.reachTraced.add(entry.repo);
    const names = [entry.repo, entry.remote?.split("/").at(-1)].filter((n) => n !== undefined);
    for (const name of new Set(names.map((n) => n.toLowerCase()))) push(this.repoNames, name, entry.repo);
    for (const fact of entry.card?.provides ?? []) {
      if (fact.kind === "app") {
        push(this.apps, fact.name.toLowerCase(), { repo: entry.repo, app: fact });
        if (fact.port !== null) push(this.ports, fact.port, { repo: entry.repo, app: fact });
      } else if (fact.kind === "endpoint") {
        const segments = httpPathSegments(fact.path);
        this.addEndpoint({ repo: entry.repo, endpoint: fact, segments, specific: segments.some(isLiteral) });
      }
    }
    for (const fact of entry.card?.consumes ?? []) if (fact.kind === "http") this.clients.push({ repo: entry.repo, client: fact });
  }

  private addEndpoint(indexed: IndexedEndpoint): void {
    this.endpoints.push(indexed);
    if (!indexed.specific) return;
    push(this.endpointsByRepo, indexed.repo, indexed);
    if (indexed.segments.includes("**")) this.tailEndpoints.push(indexed);
    else {
      push(this.endpointsByLength, indexed.segments.length, indexed);
      const length = indexed.segments.length;
      for (const [at, segment] of indexed.segments.entries()) push(this.endpointsBySegment, segmentKey(length, at, segment), indexed);
    }
  }

  /**
   * The repos the client of repo `from` calls; empty when unknown. Never `from` itself: a name, alias or port that
   * points to the client's repo ends the search without an edge (an app calls another app from the same repo).
   */
  targets(from: string, client: ConsumedHttp): HttpTarget[] {
    return this.resolve(from, client).targets;
  }

  /** The client's targets, and whether it points only to its own repo (`HttpResolution`). */
  resolve(from: string, client: ConsumedHttp): HttpResolution {
    const known = this.resolutions.get(client);
    if (known?.from === from) return known.resolution;
    const url = client.url === null ? undefined : parseHttpUrl(client.url);
    const byName = this.byName(from, client, url);
    const resolution =
      byName === undefined
        ? { targets: this.byPath(from, client, url?.path ?? ""), ownRepo: false }
        : { targets: byName.filter((t) => t.repo !== from), ownRepo: byName.every((t) => t.repo === from) };
    this.resolutions.set(client, { from, resolution });
    return resolution;
  }

  /** Targets by app name, alias, host or port, the client's own repo included; `undefined` when none of them points to anything. */
  private byName(from: string, client: ConsumedHttp, url: HttpUrl | undefined): HttpTarget[] | undefined {
    const base = url?.path ?? "";
    const name = client.app ?? (url?.scheme === "lb" ? url.host : undefined);
    const host = url && url.scheme !== "lb" ? url.host : undefined;
    const label = host?.split(".")[0];
    const port = url?.port ?? null;
    const local = host !== undefined && isLocalHost(host) && port !== null;
    const attempts: (() => HttpTarget[])[] = [
      () => (name ? this.byApp(from, name, client, base) : []),
      () => (name ? this.byAlias(name, client, base) : []),
      () => (host ? this.byAlias(host, client, base) : []),
      () => (label && !local ? this.byApp(from, label, client, base) : []),
      () => (label && !local ? this.byRepoName(label, client, base) : []),
      () => (local && port !== null ? this.byPort(port, client, base) : []),
    ];
    for (const attempt of attempts) {
      const found = attempt();
      if (found.length > 0) return found;
    }
    return undefined;
  }

  private byApp(from: string, name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const apps = this.apps.get(name.toLowerCase()) ?? [];
    // Confidence is counted from other repos: an app with this name in the client's repo does not make the target uncertain.
    const repos = new Set(apps.map((a) => a.repo).filter((r) => r !== from));
    return apps.map(({ repo, app }) => {
      const calls = this.match(repo, client, base, app.name);
      // `exact` only when every call has an endpoint in this repo: the app name alone is `high`.
      const everyCall = client.calls.length > 0 && client.calls.every((call) => calls.some((m) => m.call === call));
      const confidence = repos.size > 1 ? "medium" : everyCall ? "exact" : "high";
      return { repo, basis: "app", confidence, key: app.name, evidence: [appEvidence(repo, app)], calls };
    });
  }

  private byAlias(name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const ref = this.appAliases.get(name.toLowerCase());
    if (ref === undefined) return [];
    const evidence: EdgeEvidence = { repo: null, path: this.file, line: null, detail: `graph.apps: ${name} → ${ref}` };
    return this.resolveRef(ref).map((repo) => ({
      repo,
      basis: "alias",
      confidence: "high",
      key: name,
      evidence: [evidence],
      calls: this.match(repo, client, base),
    }));
  }

  private byRepoName(label: string, client: ConsumedHttp, base: string): HttpTarget[] {
    return (this.repoNames.get(label) ?? []).map((repo) => ({
      repo,
      basis: "repo-name",
      confidence: "medium",
      key: label,
      evidence: [],
      calls: this.match(repo, client, base),
    }));
  }

  private byPort(port: number, client: ConsumedHttp, base: string): HttpTarget[] {
    return (this.ports.get(port) ?? []).map(({ repo, app }) => ({
      repo,
      basis: "port",
      confidence: "medium",
      key: `localhost:${port}`,
      evidence: [appEvidence(repo, app)],
      calls: this.match(repo, client, base, app.name),
    }));
  }

  /** Repos with endpoints matching the client's calls: one `medium`, several `low`. */
  private byPath(from: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const byRepo = new Map<string, MatchedCall[]>();
    for (const call of client.calls) {
      const { path, segments } = callPath(base, call);
      // A path without a fixed segment (`/`, `/{id}`) would match half the endpoints, so on its own it does not point to a repo.
      if (!segments.some(isLiteral)) continue;
      const candidates = [...this.sameLength(segments), this.tailEndpoints];
      for (const list of candidates)
        for (const e of list) if (e.repo !== from && matches(call, segments, e)) push(byRepo, e.repo, { call, path, endpoint: e.endpoint });
    }
    const confidence: EdgeConfidence = byRepo.size === 1 ? "medium" : "low";
    return [...byRepo].map(([repo, calls]) => ({ repo, basis: "path", confidence, key: client.name, evidence: [], calls }));
  }

  /** Lists of endpoints without `**` with the same number of segments that can match by the call's rarest fixed segment. */
  private sameLength(segments: readonly string[]): IndexedEndpoint[][] {
    const length = segments.length;
    let best: IndexedEndpoint[][] = [this.endpointsByLength.get(length) ?? []];
    let size = best[0]?.length ?? 0;
    segments.forEach((segment, at) => {
      if (!isLiteral(segment)) return;
      const lists = [
        this.endpointsBySegment.get(segmentKey(length, at, segment)) ?? [],
        this.endpointsBySegment.get(segmentKey(length, at, "*")) ?? [],
      ];
      const count = lists.reduce((n, l) => n + l.length, 0);
      if (count < size) [best, size] = [lists, count];
    });
    return best;
  }

  /**
   * The client's calls with every endpoint of the repo (of app `app`, when given) they match by method and path:
   * `/orders/{id}` and `/orders/special` both match `/orders/special`, and `find_endpoint` asks about each one separately.
   */
  private match(repo: string, client: ConsumedHttp, base: string, app?: string): MatchedCall[] {
    const endpoints = (this.endpointsByRepo.get(repo) ?? []).filter(
      (e) => app === undefined || e.endpoint.app === null || e.endpoint.app === app,
    );
    return client.calls.flatMap((call) => {
      const { path, segments } = callPath(base, call);
      return endpoints.filter((e) => matches(call, segments, e)).map((e) => ({ call, path, endpoint: e.endpoint }));
    });
  }
}

/** Whether the host is a developer's own computer, where the port, not the name, says which app it is. */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/** The `endpointsBySegment` key: a variable (`{id}`, `*`) is `*`. */
function segmentKey(length: number, at: number, segment: string): string {
  return `${length}/${at}/${isLiteral(segment) ? segment : "*"}`;
}

/** The full call path (the path from the client's address and the call path) and its segments. */
function callPath(base: string, call: HttpCall): { path: string; segments: string[] } {
  const path = joinHttpPath(base, call.path);
  return { path, segments: httpPathSegments(path) };
}

/** Whether a path segment is fixed text, not a variable (`{id}`, `*`) or the rest of the path (`**`). */
export function isLiteral(segment: string): boolean {
  return !segment.startsWith("{") && segment !== "*" && segment !== "**";
}

function matches(call: HttpCall, segments: readonly string[], e: IndexedEndpoint): boolean {
  return httpMethodMatches(call.method, e.endpoint.method) && httpSegmentsMatch(segments, e.segments);
}

function appEvidence(repo: string, app: ProvidedApp): EdgeEvidence {
  const port = app.port === null ? "" : ` on port ${app.port}`;
  return { repo, ...app.evidence, detail: `app ${app.name}${port}` };
}

/** Whether the card traced the reach of every endpoint: a handler the call graph did not find leaves its endpoint without one. */
function tracesEveryEndpoint(card: RepoCard | null): boolean {
  return card?.reachTraced === true && card.provides.every((p) => p.kind !== "endpoint" || p.reaches !== null);
}

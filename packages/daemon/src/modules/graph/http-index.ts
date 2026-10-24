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
} from "@trackwall/protocol";
import type { GraphCardInput } from "./graph-input.ts";

/**
 * Dopasowanie klientów HTTP z kart do aplikacji i endpointów innych repo (§4.6, ADR-30), wspólne dla krawędzi `http`
 * i `find_endpoint`. Klient wskazuje repo nazwą aplikacji (Feign `name`, `lb://nazwa`, host równy
 * `spring.application.name`), aliasem aplikacji z `workspace.yaml`, hostem równym nazwie repo albo portem aplikacji
 * na `localhost`; bez żadnego z nich graf szuka repo, którego endpointy pasują do ścieżek wywołań. Ścieżki wywołań
 * z dopasowanymi endpointami są dowodami i podnoszą pewność.
 */

/** Skąd wiadomo, że klient woła repo; kolejność od najpewniejszego. */
type TargetBasis = "app" | "alias" | "repo-name" | "port" | "path";

/** Wywołanie klienta z endpointem repo, do którego pasuje. */
export interface MatchedCall {
  call: HttpCall;
  /** Pełna ścieżka: ścieżka z adresu klienta i ścieżka wywołania. */
  path: string;
  endpoint: ProvidedEndpoint;
}

/** Repo, które klient woła, z pewnością, kluczem krawędzi, dowodami po stronie celu i dopasowanymi wywołaniami. */
export interface HttpTarget {
  repo: string;
  basis: TargetBasis;
  confidence: EdgeConfidence;
  key: string;
  evidence: EdgeEvidence[];
  calls: MatchedCall[];
}

/** Klient HTTP z karty repo. */
export interface RepoClient {
  repo: string;
  client: ConsumedHttp;
}

interface AppOf {
  repo: string;
  app: ProvidedApp;
}

/** Endpoint z członami ścieżki policzonymi raz: graf porównuje z nim każde wywołanie bez celu. */
interface IndexedEndpoint {
  repo: string;
  endpoint: ProvidedEndpoint;
  segments: string[];
}

/** Hosty, pod którymi aplikacja jest na komputerze dewelopera; dla nich o celu mówi port. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"]);

export class HttpIndex {
  readonly clients: RepoClient[] = [];
  readonly endpoints: IndexedEndpoint[] = [];
  private readonly apps = new Map<string, AppOf[]>();
  private readonly ports = new Map<number, AppOf[]>();
  private readonly repoNames = new Map<string, string[]>();
  private readonly endpointsByRepo = new Map<string, IndexedEndpoint[]>();
  /** Endpointy po liczbie członów ścieżki, a z `**` osobno: wywołanie porównuje się tylko z tymi, które mogą pasować. */
  private readonly endpointsByLength = new Map<number, IndexedEndpoint[]>();
  private readonly tailEndpoints: IndexedEndpoint[] = [];
  private readonly appAliases: Map<string, string>;
  private readonly resolve: (ref: string) => string[];
  private readonly file: string;

  constructor(cards: readonly GraphCardInput[], aliases: { apps: Map<string, string>; resolve: (ref: string) => string[]; file: string }) {
    this.appAliases = aliases.apps;
    this.resolve = aliases.resolve;
    this.file = aliases.file;
    for (const entry of cards) if (entry.kind === "ok") this.addRepo(entry);
  }

  private addRepo(entry: Extract<GraphCardInput, { kind: "ok" }>): void {
    const names = [entry.repo, entry.remote?.split("/").at(-1)].filter((n) => n !== undefined);
    for (const name of new Set(names.map((n) => n.toLowerCase()))) push(this.repoNames, name, entry.repo);
    for (const fact of entry.card?.provides ?? []) {
      if (fact.kind === "app") {
        push(this.apps, fact.name.toLowerCase(), { repo: entry.repo, app: fact });
        if (fact.port !== null) push(this.ports, fact.port, { repo: entry.repo, app: fact });
      } else if (fact.kind === "endpoint") this.addEndpoint({ repo: entry.repo, endpoint: fact, segments: httpPathSegments(fact.path) });
    }
    for (const fact of entry.card?.consumes ?? []) if (fact.kind === "http") this.clients.push({ repo: entry.repo, client: fact });
  }

  private addEndpoint(indexed: IndexedEndpoint): void {
    this.endpoints.push(indexed);
    push(this.endpointsByRepo, indexed.repo, indexed);
    if (indexed.segments.includes("**")) this.tailEndpoints.push(indexed);
    else push(this.endpointsByLength, indexed.segments.length, indexed);
  }

  /** Repo, które klient repo `from` woła; puste, gdy nie wiadomo. Nigdy samo `from`. */
  targets(from: string, client: ConsumedHttp): HttpTarget[] {
    const url = client.url === null ? undefined : parseHttpUrl(client.url);
    return this.byName(from, client, url) ?? this.byPath(from, client, url?.path ?? "");
  }

  /** Cele po nazwie aplikacji, aliasie, hoście albo porcie; `undefined`, gdy żaden nie wskazuje innego repo. */
  private byName(from: string, client: ConsumedHttp, url: HttpUrl | undefined): HttpTarget[] | undefined {
    const base = url?.path ?? "";
    const name = client.app ?? (url?.scheme === "lb" ? url.host : undefined);
    const host = url && url.scheme !== "lb" ? url.host : undefined;
    const label = host?.split(".")[0];
    const port = url?.port ?? null;
    const local = host !== undefined && LOCAL_HOSTS.has(host) && port !== null;
    const attempts: (() => HttpTarget[])[] = [
      () => (name ? this.byApp(from, name, client, base) : []),
      () => (name ? this.byAlias(from, name, client, base) : []),
      () => (host ? this.byAlias(from, host, client, base) : []),
      () => (label && !local ? this.byApp(from, label, client, base) : []),
      () => (label && !local ? this.byRepoName(from, label, client, base) : []),
      () => (local && port !== null ? this.byPort(from, port, client, base) : []),
    ];
    for (const attempt of attempts) {
      const found = attempt();
      if (found.length > 0) return found;
    }
    return undefined;
  }

  private byApp(from: string, name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const apps = (this.apps.get(name.toLowerCase()) ?? []).filter((a) => a.repo !== from);
    const repos = new Set(apps.map((a) => a.repo));
    return apps.map(({ repo, app }) => {
      const calls = this.match(repo, client, base, app.name);
      const confidence = repos.size > 1 ? "medium" : calls.length > 0 ? "exact" : "high";
      return { repo, basis: "app", confidence, key: app.name, evidence: [appEvidence(repo, app)], calls };
    });
  }

  private byAlias(from: string, name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const ref = this.appAliases.get(name.toLowerCase());
    if (ref === undefined) return [];
    const evidence: EdgeEvidence = { repo: null, path: this.file, line: null, detail: `graph.apps: ${name} → ${ref}` };
    return this.resolve(ref)
      .filter((repo) => repo !== from)
      .map((repo) => ({ repo, basis: "alias", confidence: "high", key: name, evidence: [evidence], calls: this.match(repo, client, base) }));
  }

  private byRepoName(from: string, label: string, client: ConsumedHttp, base: string): HttpTarget[] {
    return (this.repoNames.get(label) ?? [])
      .filter((repo) => repo !== from)
      .map((repo) => ({ repo, basis: "repo-name", confidence: "medium", key: label, evidence: [], calls: this.match(repo, client, base) }));
  }

  private byPort(from: string, port: number, client: ConsumedHttp, base: string): HttpTarget[] {
    return (this.ports.get(port) ?? [])
      .filter((a) => a.repo !== from)
      .map(({ repo, app }) => ({
        repo,
        basis: "port",
        confidence: "medium",
        key: `localhost:${port}`,
        evidence: [appEvidence(repo, app)],
        calls: this.match(repo, client, base, app.name),
      }));
  }

  /** Repo z endpointami pasującymi do wywołań klienta: jedno `medium`, kilka `low`. */
  private byPath(from: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const byRepo = new Map<string, MatchedCall[]>();
    for (const call of client.calls) {
      const path = joinHttpPath(base, call.path);
      const segments = httpPathSegments(path);
      // Ścieżka bez stałego członu (`/`, `/{id}`) pasowałaby do połowy endpointów, więc sama nie wskazuje repo.
      if (!segments.some(isLiteral)) continue;
      const candidates = [...(this.endpointsByLength.get(segments.length) ?? []), ...this.tailEndpoints];
      const matched = new Set<string>();
      for (const e of candidates) {
        if (e.repo === from || matched.has(e.repo) || !matches(call, segments, e)) continue;
        matched.add(e.repo);
        push(byRepo, e.repo, { call, path, endpoint: e.endpoint });
      }
    }
    const confidence: EdgeConfidence = byRepo.size === 1 ? "medium" : "low";
    return [...byRepo].map(([repo, calls]) => ({ repo, basis: "path", confidence, key: client.name, evidence: [], calls }));
  }

  /** Wywołania klienta z endpointem repo (aplikacji `app`, gdy podana), do którego pasują metodą i ścieżką. */
  private match(repo: string, client: ConsumedHttp, base: string, app?: string): MatchedCall[] {
    const endpoints = (this.endpointsByRepo.get(repo) ?? []).filter((e) => app === undefined || e.endpoint.app === null || e.endpoint.app === app);
    return client.calls.flatMap((call) => {
      const path = joinHttpPath(base, call.path);
      const segments = httpPathSegments(path);
      const found = endpoints.find((e) => matches(call, segments, e));
      return found ? [{ call, path, endpoint: found.endpoint }] : [];
    });
  }
}

function isLiteral(segment: string): boolean {
  return !segment.startsWith("{") && segment !== "*" && segment !== "**";
}

function matches(call: HttpCall, segments: readonly string[], e: IndexedEndpoint): boolean {
  return httpMethodMatches(call.method, e.endpoint.method) && httpSegmentsMatch(segments, e.segments);
}

function appEvidence(repo: string, app: ProvidedApp): EdgeEvidence {
  const port = app.port === null ? "" : ` na porcie ${app.port}`;
  return { repo, ...app.evidence, detail: `aplikacja ${app.name}${port}` };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

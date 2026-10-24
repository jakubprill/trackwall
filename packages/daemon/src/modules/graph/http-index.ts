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
import { type Join, push } from "./graph-join.ts";

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
  /**
   * Czy ścieżka ma stały człon (`/api/**` tak, `/**` i `/{path}` nie). Endpoint bez niego (przekierowanie wszystkiego
   * do aplikacji SPA) pasowałby do każdego wywołania, więc nie jest dowodem połączenia.
   */
  specific: boolean;
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
  /**
   * Endpointy po liczbie członów, pozycji i członie na niej (`3/0/api`, ze zmienną `3/2/*`). Wywołanie porównuje się
   * tylko z endpointami, które mają jego najrzadszy stały człon (albo zmienną) na tej samej pozycji, więc tysiące
   * endpointów w kilkudziesięciu repo nie mnożą się przez każde wywołanie (§8).
   */
  private readonly endpointsBySegment = new Map<string, IndexedEndpoint[]>();
  private readonly tailEndpoints: IndexedEndpoint[] = [];
  private readonly appAliases: Map<string, string>;
  private readonly resolve: (ref: string) => string[];
  private readonly file: string;

  constructor(cards: readonly GraphCardInput[], join: Pick<Join, "appAliases" | "resolve" | "file">) {
    this.appAliases = join.appAliases;
    this.resolve = join.resolve;
    this.file = join.file;
    for (const entry of cards) if (entry.kind === "ok") this.addRepo(entry);
  }

  private addRepo(entry: Extract<GraphCardInput, { kind: "ok" }>): void {
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
   * Repo, które klient repo `from` woła; puste, gdy nie wiadomo. Nigdy samo `from`: nazwa, alias albo port, które
   * wskazują repo klienta, kończą szukanie bez krawędzi (aplikacja woła inną aplikację z tego samego repo).
   */
  targets(from: string, client: ConsumedHttp): HttpTarget[] {
    const url = client.url === null ? undefined : parseHttpUrl(client.url);
    return this.byName(from, client, url) ?? this.byPath(from, client, url?.path ?? "");
  }

  /** Cele po nazwie aplikacji, aliasie, hoście albo porcie; `undefined`, gdy żaden niczego nie wskazuje. */
  private byName(from: string, client: ConsumedHttp, url: HttpUrl | undefined): HttpTarget[] | undefined {
    const base = url?.path ?? "";
    const name = client.app ?? (url?.scheme === "lb" ? url.host : undefined);
    const host = url && url.scheme !== "lb" ? url.host : undefined;
    const label = host?.split(".")[0];
    const port = url?.port ?? null;
    const local = host !== undefined && LOCAL_HOSTS.has(host) && port !== null;
    const attempts: (() => HttpTarget[])[] = [
      () => (name ? this.byApp(name, client, base) : []),
      () => (name ? this.byAlias(name, client, base) : []),
      () => (host ? this.byAlias(host, client, base) : []),
      () => (label && !local ? this.byApp(label, client, base) : []),
      () => (label && !local ? this.byRepoName(label, client, base) : []),
      () => (local && port !== null ? this.byPort(port, client, base) : []),
    ];
    for (const attempt of attempts) {
      const found = attempt();
      if (found.length > 0) return found.filter((t) => t.repo !== from);
    }
    return undefined;
  }

  private byApp(name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const apps = this.apps.get(name.toLowerCase()) ?? [];
    const repos = new Set(apps.map((a) => a.repo));
    return apps.map(({ repo, app }) => {
      const calls = this.match(repo, client, base, app.name);
      // `exact` dopiero, gdy każde wywołanie ma endpoint w tym repo: sama nazwa aplikacji to `high`.
      const everyCall = client.calls.length > 0 && client.calls.every((call) => calls.some((m) => m.call === call));
      const confidence = repos.size > 1 ? "medium" : everyCall ? "exact" : "high";
      return { repo, basis: "app", confidence, key: app.name, evidence: [appEvidence(repo, app)], calls };
    });
  }

  private byAlias(name: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const ref = this.appAliases.get(name.toLowerCase());
    if (ref === undefined) return [];
    const evidence: EdgeEvidence = { repo: null, path: this.file, line: null, detail: `graph.apps: ${name} → ${ref}` };
    return this.resolve(ref).map((repo) => ({
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

  /** Repo z endpointami pasującymi do wywołań klienta: jedno `medium`, kilka `low`. */
  private byPath(from: string, client: ConsumedHttp, base: string): HttpTarget[] {
    const byRepo = new Map<string, MatchedCall[]>();
    for (const call of client.calls) {
      const { path, segments } = callPath(base, call);
      // Ścieżka bez stałego członu (`/`, `/{id}`) pasowałaby do połowy endpointów, więc sama nie wskazuje repo.
      if (!segments.some(isLiteral)) continue;
      const candidates = [...this.sameLength(segments), this.tailEndpoints];
      for (const list of candidates)
        for (const e of list) if (e.repo !== from && matches(call, segments, e)) push(byRepo, e.repo, { call, path, endpoint: e.endpoint });
    }
    const confidence: EdgeConfidence = byRepo.size === 1 ? "medium" : "low";
    return [...byRepo].map(([repo, calls]) => ({ repo, basis: "path", confidence, key: client.name, evidence: [], calls }));
  }

  /** Listy endpointów bez `**` o tej samej liczbie członów, które mogą pasować najrzadszym stałym członem wywołania. */
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
   * Wywołania klienta z każdym endpointem repo (aplikacji `app`, gdy podana), do którego pasują metodą i ścieżką:
   * `/orders/{id}` i `/orders/special` pasują do `/orders/special` oba, a `find_endpoint` pyta o każdy z osobna.
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

/** Klucz `endpointsBySegment`: zmienna (`{id}`, `*`) to `*`. */
function segmentKey(length: number, at: number, segment: string): string {
  return `${length}/${at}/${isLiteral(segment) ? segment : "*"}`;
}

/** Pełna ścieżka wywołania (ścieżka z adresu klienta i ścieżka wywołania) i jej człony. */
function callPath(base: string, call: HttpCall): { path: string; segments: string[] } {
  const path = joinHttpPath(base, call.path);
  return { path, segments: httpPathSegments(path) };
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

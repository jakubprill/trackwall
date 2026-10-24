import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { MechanismEvidence, TagName } from "./cards.ts";
import { Evidence } from "./evidence.ts";
import { HttpClientVia, HttpMethod } from "./http.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `graph` (§4.6, ADR-29, ADR-30): graf połączeń między repo z folderu z projektami. Krawędź to złączenie
 * paczki, której repo używa, z repo, które ją buduje, klienta HTTP z aplikacją albo endpointem innego repo (karty repo,
 * ADR-25), albo wpis użytkownika w `workspace.yaml`.
 * Każda krawędź ma dowody, a graf jest liczony z kart od nowa, gdy zmieni się commit któregoś repo albo konfiguracja,
 * więc nie ma trwałego stanu.
 */

/**
 * Wskazanie repo w `workspace.yaml`: identyfikator z listy repo albo adres repo zdalnego (`host/ścieżka`, jak
 * `Repo.remote`). Adres przetrwa zmianę nazwy katalogu, identyfikator jest krótszy.
 */
export const RepoRef = z.string().min(1).max(300);
export type RepoRef = z.infer<typeof RepoRef>;

/** Ręczna krawędź: połączenie, którego karty nie widzą (np. wywołanie HTTP przez bramkę). */
export const ManualEdge = z
  .object({
    /** Repo, które używa (wywołuje, zależy od). */
    from: RepoRef,
    /** Repo, którego `from` używa. */
    to: RepoRef,
    /** Opis połączenia dla człowieka i agenta, np. `HTTP /api/orders`. */
    note: z.string().min(1).max(200),
  })
  .strict();
export type ManualEdge = z.infer<typeof ManualEdge>;

/**
 * Klucz `graph` w `workspace.yaml` (ADR-29), tylko ręcznie w pliku, bo połączenia między repo z pracy zna tylko
 * użytkownik (ADR-7). `packages`: alias paczki, czyli nazwa paczki (`grupa:artefakt`, nazwa npm) i repo, które ją
 * dostarcza, gdy karta tego repo jej nie pokazuje (paczka budowana poza plikami buildu, inna nazwa w repozytorium
 * artefaktów). `apps`: alias aplikacji, czyli nazwa aplikacji albo host z adresu klienta HTTP (`orders`,
 * `orders.internal.example.com`) i repo, które ją wystawia, gdy żadna karta nie ma aplikacji o tej nazwie (nazwa
 * w DNS klastra inna niż `spring.application.name`, bramka). `edges`: ręczne krawędzie.
 */
export const GraphConfig = z
  .object({
    // Pusty podklucz (`packages:` z zakomentowanymi wpisami) YAML czyta jako `null`, tak jak brak klucza.
    packages: z
      .record(z.string().min(1).max(300), RepoRef)
      .nullish()
      .transform((packages) => packages ?? {}),
    apps: z
      .record(z.string().min(1).max(300), RepoRef)
      .nullish()
      .transform((apps) => apps ?? {}),
    edges: z
      .array(ManualEdge)
      .nullish()
      .transform((edges) => edges ?? []),
  })
  .strict();
export type GraphConfig = z.infer<typeof GraphConfig>;

/**
 * Skąd jest krawędź: `package` z kart (repo używa paczki, którą buduje drugie), `http` z kart (klient HTTP repo woła
 * aplikację albo endpoint drugiego), `manual` z wpisu w `workspace.yaml`. Topiki przyjdą z ekstraktorami kart.
 */
export const EdgeKind = z.enum(["package", "http", "manual"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/**
 * Pewność krawędzi. Paczka: `exact`, gdy buduje ją dokładnie jedno repo; `high` z aliasu paczki; `medium`, gdy
 * buduje ją kilka repo z listy (np. dwa klony jednego repo). HTTP (ADR-30): `exact`, gdy nazwa aplikacji wskazuje
 * jedno repo, a każde wywołanie ma w nim endpoint; `high` za samą nazwę aplikacji albo z aliasu aplikacji; `medium` za host równy
 * nazwie repo, port aplikacji na `localhost`, ścieżki pasujące do endpointów jednego repo albo nazwę w kilku repo;
 * `low` za ścieżki pasujące do endpointów kilku repo. Ręczna krawędź `exact`.
 */
export const EdgeConfidence = z.enum(["exact", "high", "medium", "low"]);
export type EdgeConfidence = z.infer<typeof EdgeConfidence>;

/**
 * Dowód krawędzi: miejsce w repo (plik i linia w commicie z karty) albo w `workspace.yaml` (`repo: null`, pełna
 * ścieżka), ze zdaniem, co w tym miejscu wskazuje połączenie, np. `używa com.example:orders-client (compile)`.
 */
export const EdgeEvidence = MechanismEvidence.extend({ repo: RepoId.nullable() });
export type EdgeEvidence = z.infer<typeof EdgeEvidence>;

/** Krawędź od repo, które używa, do repo, którego używa. */
export const GraphEdge = z.object({
  from: RepoId,
  to: RepoId,
  kind: EdgeKind,
  /** Nazwa paczki dla `package`, nazwa aplikacji albo adres klienta dla `http`, opis z `workspace.yaml` dla `manual`. */
  key: z.string(),
  confidence: EdgeConfidence,
  evidence: z.array(EdgeEvidence).min(1),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** Repo jako węzeł grafu. */
export const GraphNode = z.object({
  repo: RepoId,
  /** Adres repo zdalnego (`host/ścieżka`); `null` bez remote. */
  remote: z.string().nullable(),
  tags: z.array(TagName),
  /** Ile paczek repo buduje; `null`, gdy karty nie da się policzyć. */
  provides: z.number().int().nonnegative().nullable(),
  /** Nazwy aplikacji Spring Boot z karty (ADR-30). */
  apps: z.array(z.string()),
  /** Ile endpointów HTTP repo udostępnia; `null`, gdy karty nie da się policzyć. */
  endpoints: z.number().int().nonnegative().nullable(),
  /** Powód, dla którego karty nie ma (git nie czyta repo); wtedy repo jest w grafie bez krawędzi z kart. */
  problem: z.string().nullable(),
});
export type GraphNode = z.infer<typeof GraphNode>;

/** Cały graf: węzły w kolejności listy repo, krawędzie i błędy wpisów `graph` w `workspace.yaml`. */
export const RepoGraph = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  /** Wpis `graph` w `workspace.yaml`, którego nie da się użyć (np. repo spoza listy), jako zdanie dla człowieka. */
  configProblems: z.array(z.string()),
  /** Pełna ścieżka `workspace.yaml`, w którym dopisuje się aliasy paczek i ręczne krawędzie. */
  configFile: z.string(),
});
export type RepoGraph = z.infer<typeof RepoGraph>;

/** Najdalsze sąsiedztwo w `subgraph_for`: dalej graf firmowy to zwykle cały graf, a wynik przestaje mieścić się w kontekście agenta. */
export const MAX_SUBGRAPH_DEPTH = 3;

/** Fragment grafu wokół jednego repo. */
export const Subgraph = z.object({
  repo: RepoId,
  depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type Subgraph = z.infer<typeof Subgraph>;

export const WhoCallsResult = z.object({
  repo: RepoId,
  /** Krawędzie do tego repo: kto go używa, czego (klucz) i skąd to wiadomo (dowody). */
  edges: z.array(GraphEdge),
});
export type WhoCallsResult = z.infer<typeof WhoCallsResult>;

/** Najwięcej endpointów w wyniku `find_endpoint`: więcej nie mieści się sensownie w kontekście agenta. */
export const MAX_FOUND_ENDPOINTS = 50;

/** Repo, którego klient HTTP woła znaleziony endpoint (ADR-30). */
export const EndpointCaller = z.object({
  repo: RepoId,
  via: HttpClientVia,
  /** Nazwa klienta z karty (interfejs Feign, klasa z wywołaniami). */
  client: z.string(),
  method: HttpMethod.nullable(),
  /** Pełna ścieżka wywołania (ścieżka z adresu klienta i ścieżka wywołania). */
  path: z.string(),
  confidence: EdgeConfidence,
  evidence: Evidence,
});
export type EndpointCaller = z.infer<typeof EndpointCaller>;

/** Endpoint z karty repo pasujący do zapytania, z repo, które go wołają. */
export const FoundEndpoint = z.object({
  repo: RepoId,
  app: z.string().nullable(),
  method: HttpMethod.nullable(),
  path: z.string(),
  handler: z.string(),
  /** Typ ciała żądania i odpowiedzi z karty (ADR-38). */
  request: z.string().nullable(),
  response: z.string().nullable(),
  evidence: Evidence,
  callers: z.array(EndpointCaller),
});
export type FoundEndpoint = z.infer<typeof FoundEndpoint>;

export const FindEndpointResult = z.object({
  query: z.string(),
  endpoints: z.array(FoundEndpoint),
  /** Pasujących było więcej niż `MAX_FOUND_ENDPOINTS`; zawęź zapytanie. */
  truncated: z.boolean(),
});
export type FindEndpointResult = z.infer<typeof FindEndpointResult>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/graph/${action}`, request, data };
}

export const graphApi = {
  /** Graf wszystkich repo z folderu z projektami, liczony z kart (pierwsze pytanie o commit czyta pliki z gita). */
  graph: endpoint("graph", z.object({}).strict(), RepoGraph),
};

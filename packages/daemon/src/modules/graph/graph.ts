import {
  type FindEndpointResult,
  GraphConfig,
  type HttpMethod,
  type RepoGraph,
  type Subgraph,
  type WhoCallsResult,
} from "@trackwall/protocol";
import { configOrProblem, DomainError } from "../../errors.ts";
import { buildGraphWithIndex } from "./build-graph.ts";
import { findEndpoints } from "./find-endpoint.ts";
import type { GraphCardInput, GraphConfigInput } from "./graph-input.ts";
import type { HttpIndex } from "./http-index.ts";
import { subgraph } from "./subgraph.ts";

/**
 * Moduł `graph` (§4, §4.6, ADR-29, ADR-30): graf połączeń między repo z kart (`cards`) i z wpisów `graph`
 * w `workspace.yaml`, liczony od nowa, gdy zmieni się commit któregoś repo albo konfiguracja. Karty są w pamięci
 * podręcznej po commicie, więc pytanie kosztuje tyle co lista tagów: odczyt HEAD i remote każdego repo.
 */

/** Czego `graph` potrzebuje od `cards`; podłączane w fasadzie. */
interface GraphCards {
  all(): Promise<{ cards: GraphCardInput[]; tagRulesProblem: string | null }>;
}

/** Czego `graph` potrzebuje od `workspace`: wpisy `graph` z `workspace.yaml`. */
interface GraphWorkspace {
  graphConfig(): GraphConfig;
  configFile(): string;
}

export interface GraphDeps {
  cards: GraphCards;
  workspace: GraphWorkspace;
}

export class Graph {
  private readonly deps: GraphDeps;
  /**
   * Ostatni policzony graf z kluczem wejścia (ADR-30): krawędzie HTTP porównują wywołania z endpointami wszystkich
   * repo, więc te same commity i ta sama konfiguracja nie liczą grafu drugi raz (UI odpytuje go co 30 s).
   */
  private last: { key: string; graph: RepoGraph; http: HttpIndex } | undefined;

  constructor(deps: GraphDeps) {
    this.deps = deps;
  }

  async graph(): Promise<RepoGraph> {
    return (await this.current()).graph;
  }

  /** Endpointy HTTP z kart wszystkich repo pasujące do zapytania, z repo, które je wołają (ADR-30). */
  async findEndpoint(query: string, method: HttpMethod | undefined): Promise<FindEndpointResult> {
    return findEndpoints((await this.current()).http, query, method);
  }

  private async current(): Promise<{ graph: RepoGraph; http: HttpIndex }> {
    const { cards, input } = await this.inputs();
    const key = graphKey(cards, input);
    if (this.last?.key !== key) this.last = { key, ...buildGraphWithIndex(cards, input) };
    return this.last;
  }

  private async inputs(): Promise<{ cards: GraphCardInput[]; input: GraphConfigInput }> {
    const { cards, tagRulesProblem } = await this.deps.cards.all();
    // Zły klucz `graph` nie zabiera krawędzi z kart: graf powstaje bez wpisów użytkownika, z powodem do poprawienia.
    const { value: config, problem } = configOrProblem(() => this.deps.workspace.graphConfig(), GraphConfig.parse({}));
    const problems = [tagRulesProblem, problem].filter((p) => p !== null);
    return { cards, input: { config, file: this.deps.workspace.configFile(), problems } };
  }

  /** Krawędzie do repo: kto go używa. */
  async whoCalls(repo: string): Promise<WhoCallsResult> {
    const graph = await this.graphWith(repo);
    return { repo, edges: graph.edges.filter((e) => e.to === repo) };
  }

  async subgraph(repo: string, depth: number): Promise<Subgraph> {
    return subgraph(await this.graphWith(repo), repo, depth);
  }

  private async graphWith(repo: string): Promise<RepoGraph> {
    const graph = await this.graph();
    if (!graph.nodes.some((n) => n.repo === repo)) throw new DomainError("not_found", `no repo "${repo}" in the projects folder`);
    return graph;
  }
}

/**
 * Klucz wejścia grafu: karta zależy tylko od commita (ADR-25), więc wystarczą commity, adresy, tagi i powody braku
 * karty oraz konfiguracja `graph`.
 */
function graphKey(cards: readonly GraphCardInput[], input: GraphConfigInput): string {
  const repos = cards.map((c) => (c.kind === "ok" ? [c.repo, c.remote, c.card?.commit ?? null, c.tags] : [c.repo, c.message]));
  return JSON.stringify([repos, input]);
}

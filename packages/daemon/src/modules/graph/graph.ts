import type { GraphConfig, GraphEdge, RepoGraph, Subgraph } from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { buildGraph, type GraphCardInput } from "./build-graph.ts";
import { subgraph } from "./subgraph.ts";

/**
 * Moduł `graph` (§4, §4.6, ADR-29): graf połączeń między repo z kart (`cards`) i z wpisów `graph` w `workspace.yaml`,
 * liczony przy każdym pytaniu. Karty są w pamięci podręcznej po commicie, więc pytanie kosztuje tyle co lista tagów:
 * odczyt HEAD i remote każdego repo.
 */

/** Czego `graph` potrzebuje od `cards`; podłączane w fasadzie. */
interface GraphCards {
  all(): Promise<GraphCardInput[]>;
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

  constructor(deps: GraphDeps) {
    this.deps = deps;
  }

  async graph(): Promise<RepoGraph> {
    const cards = await this.deps.cards.all();
    const file = this.deps.workspace.configFile();
    try {
      return buildGraph(cards, { config: this.deps.workspace.graphConfig(), file });
    } catch (err) {
      // Zły klucz `graph` nie zabiera krawędzi z kart: graf powstaje bez wpisów użytkownika, z powodem do poprawienia.
      if (!(err instanceof DomainError && err.code === "invalid_config")) throw err;
      return buildGraph(cards, { config: { packages: {}, edges: [] }, file }, [err.message]);
    }
  }

  /** Krawędzie do repo: kto go używa. */
  async whoCalls(repo: string): Promise<GraphEdge[]> {
    const graph = await this.graphWith(repo);
    return graph.edges.filter((e) => e.to === repo);
  }

  async subgraph(repo: string, depth: number): Promise<Subgraph> {
    return subgraph(await this.graphWith(repo), repo, depth);
  }

  private async graphWith(repo: string): Promise<RepoGraph> {
    const graph = await this.graph();
    if (!graph.nodes.some((n) => n.repo === repo)) throw new DomainError("not_found", `w folderze z projektami nie ma repo "${repo}"`);
    return graph;
  }
}

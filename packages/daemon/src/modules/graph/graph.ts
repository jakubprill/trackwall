import {
  type CardProblem,
  type ChangedEndpoint,
  type ChangedEndpoints,
  type FindEndpointResult,
  GraphConfig,
  type HttpMethod,
  type RepoGraph,
  type Subgraph,
  type WhoCallsResult,
} from "@trackwall/protocol";
import { configOrProblem, DomainError } from "../../infra/errors.ts";
import { buildGraphWithIndex } from "./build-graph.ts";
import { withCallers } from "./changed-endpoints.ts";
import { findEndpoints } from "./find-endpoint.ts";
import type { GraphCardInput, GraphConfigInput } from "./graph-input.ts";
import type { HttpIndex } from "./http-index.ts";
import { subgraph } from "./subgraph.ts";

/**
 * The `graph` module (§4, §4.6, ADR-29, ADR-30): the graph of connections between repos from the cards (`cards`) and from the `graph`
 * entries in `workspace.yaml`, recomputed when the commit of some repo or the configuration changes. The cards are cached
 * by commit, so a question costs as much as the tag list: a read of every repo's HEAD and remote.
 */

/** What `graph` needs from `cards`; wired in the facade. */
interface GraphCards {
  all(): Promise<{ cards: GraphCardInput[]; tagRulesProblem: string | null }>;
  endpointChanges(
    dir: string,
    base: string,
  ): Promise<{ head: string; changes: Omit<ChangedEndpoint, "callers">[]; problems: CardProblem[] }>;
}

/** What `graph` needs from `workspace`: the `graph` entries from `workspace.yaml`. */
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
   * The last computed graph with its input key (ADR-30): HTTP edges compare calls with the endpoints of all
   * repos, so the same commits and the same configuration do not compute the graph a second time (the UI asks for it after every repo change and as a safety net, ADR-63).
   */
  private last: { key: string; graph: RepoGraph; http: HttpIndex } | undefined;

  constructor(deps: GraphDeps) {
    this.deps = deps;
  }

  async graph(): Promise<RepoGraph> {
    return (await this.current()).graph;
  }

  /** HTTP endpoints from the cards of all repos matching the query, with the repos that call them (ADR-30). */
  async findEndpoint(query: string, method: HttpMethod | undefined): Promise<FindEndpointResult> {
    return findEndpoints((await this.current()).http, query, method);
  }

  /**
   * The endpoints the commits in `dir`, a worktree of repo `repo`, change against commit `base`, with the repos that call
   * them (`get_changed_endpoints`, ADR-145).
   */
  async changedEndpoints(repo: string, dir: string, base: string): Promise<ChangedEndpoints> {
    const [{ head, changes, problems }, { http }] = await Promise.all([this.deps.cards.endpointChanges(dir, base), this.current()]);
    return { repo, base, head, ...withCallers(http, repo, changes), problems };
  }

  private async current(): Promise<{ graph: RepoGraph; http: HttpIndex }> {
    const { cards, input } = await this.inputs();
    const key = graphKey(cards, input);
    if (this.last?.key !== key) this.last = { key, ...buildGraphWithIndex(cards, input) };
    return this.last;
  }

  private async inputs(): Promise<{ cards: GraphCardInput[]; input: GraphConfigInput }> {
    const { cards, tagRulesProblem } = await this.deps.cards.all();
    // A bad `graph` key does not take away the edges from the cards: the graph is built without the user's entries, with a reason to fix.
    const { value: config, problem } = configOrProblem(() => this.deps.workspace.graphConfig(), GraphConfig.parse({}));
    const problems = [tagRulesProblem, problem].filter((p) => p !== null);
    return { cards, input: { config, file: this.deps.workspace.configFile(), problems } };
  }

  /** Edges into a repo: who uses it. */
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
 * The graph's input key: a card depends only on the commit (ADR-25), so the commits, addresses, tags and reasons for a missing
 * card, plus the `graph` configuration, are enough.
 */
function graphKey(cards: readonly GraphCardInput[], input: GraphConfigInput): string {
  const repos = cards.map((c) => (c.kind === "ok" ? [c.repo, c.remote, c.card?.commit ?? null, c.tags] : [c.repo, c.message]));
  return JSON.stringify([repos, input]);
}

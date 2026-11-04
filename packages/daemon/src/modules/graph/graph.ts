import {
  type ChangeCardProblem,
  type ChangedEndpoints,
  type ChangedType,
  type EndpointChanges,
  type FindEndpointResult,
  GraphConfig,
  type HttpMethod,
  type RepoGraph,
  type Subgraph,
  type TypeChange,
  type WhoCallsResult,
} from "@trackwall/protocol";
import { configOrProblem, DomainError } from "../../infra/errors.ts";
import { buildGraphWithIndex } from "./build-graph.ts";
import { withCallers } from "./changed-endpoints.ts";
import { findEndpoints } from "./find-endpoint.ts";
import type { GraphCardInput, GraphConfigInput } from "./graph-input.ts";
import type { HttpIndex } from "./http-index.ts";
import { type LibrarySearch, packageConsumers, withLibraryUsers, withUsers } from "./library-users.ts";
import { subgraph } from "./subgraph.ts";

/**
 * The `graph` module (§4, §4.6, ADR-29, ADR-30): the graph of connections between repos from the cards (`cards`) and from the `graph`
 * entries in `workspace.yaml`, recomputed when the commit of some repo or the configuration changes. The cards are cached
 * by commit, so a question costs as much as the tag list: a read of every repo's HEAD and remote.
 */

/** What `graph` needs from `cards`; wired in the facade. */
interface GraphCards {
  all(): Promise<{ cards: GraphCardInput[]; tagRulesProblem: string | null }>;
  endpointChanges(repo: string, dir: string, base: string): Promise<EndpointChanges>;
  libraryTypeChanges(
    repo: string,
    dir: string,
    base: string,
    head: string,
  ): Promise<{ types: TypeChange[]; problems: ChangeCardProblem[] }>;
}

/** What `graph` needs from `workspace`: the `graph` entries from `workspace.yaml`, and code search for imports (ADR-205). */
interface GraphWorkspace {
  graphConfig(): GraphConfig;
  configFile(): string;
  searchCode: LibrarySearch;
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
  /** The last users of changed library types, keyed by the graph's key, the consumers and the changes (ADR-205). */
  private lastUsers: { key: string; types: ChangedType[]; truncated: boolean } | undefined;

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
   * The endpoints and the public Java types of its packages that the commits in `dir`, a worktree of repo `repo`, change
   * against commit `base`, with the repos that call or import them (`get_changed_endpoints`, ADR-145, ADR-205).
   */
  async changedEndpoints(repo: string, dir: string, base: string): Promise<ChangedEndpoints> {
    const [{ changes, ...read }, { key, graph, http }] = await Promise.all([
      this.deps.cards.endpointChanges(repo, dir, base),
      this.current(),
    ]);
    const { endpoints, truncated, impact } = withCallers(http, repo, changes);
    const library = await this.libraryUsers(repo, dir, { base, head: read.head }, { key, graph });
    return {
      repo,
      base,
      ...read,
      problems: [...read.problems, ...library.problems],
      endpoints,
      types: library.types,
      truncated: truncated || library.truncated,
      impact: withLibraryUsers(impact, repo, library.types),
    };
  }

  /**
   * The changed library types of the commits with the repos that import them (ADR-205). Only a repo some repo depends
   * on is compared, so a task in an app reads no extra file. The users of the same changes in the same graph are kept,
   * since the Impact tab asks again every few seconds.
   */
  private async libraryUsers(
    repo: string,
    dir: string,
    { base, head }: { base: string; head: string },
    { key: graphVersion, graph }: { key: string; graph: RepoGraph },
  ): Promise<{ types: ChangedType[]; truncated: boolean; problems: ChangeCardProblem[] }> {
    const consumers = packageConsumers(graph, repo);
    if (consumers.length === 0) return { types: [], truncated: false, problems: [] };
    const { types: changes, problems } = await this.deps.cards.libraryTypeChanges(repo, dir, base, head);
    const key = JSON.stringify([graphVersion, consumers, changes]);
    if (this.lastUsers?.key === key) return { types: this.lastUsers.types, truncated: this.lastUsers.truncated, problems };
    const found = await withUsers(changes, consumers, (query, repos) => this.deps.workspace.searchCode(query, repos));
    // A search git failed in a repo may pass next time, so it is not kept.
    if (!found.failed) this.lastUsers = { key, types: found.types, truncated: found.truncated };
    return { types: found.types, truncated: found.truncated, problems };
  }

  private async current(): Promise<{ key: string; graph: RepoGraph; http: HttpIndex }> {
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

import { z } from "zod";
import { apiEndpoints } from "./api.ts";
import { CardProblem, MechanismEvidence, TagName } from "./cards.ts";
import { Evidence } from "./evidence.ts";
import { EndpointSource, HttpClientVia, HttpMethod, OpenApiOperation } from "./http.ts";
import { CommitHash, RepoId } from "./workspace.ts";

/**
 * Contract of the `graph` module (§4.6, ADR-29, ADR-30, ADR-116): the graph of connections between the repos of the projects folder.
 * An edge joins a package a repo uses with the repo that builds it, an HTTP client with an application or endpoint of
 * another repo (repo cards, ADR-25), or comes from a user entry in `workspace.yaml`.
 * Every edge has evidence, and the graph is computed from the cards anew when a repo's commit or the configuration
 * changes, so there is no persistent state.
 */

/**
 * A repo reference in `workspace.yaml`: an identifier from the repo list or a remote address (`host/path`, like
 * `Repo.remote`). The address survives a directory rename; the identifier is shorter.
 */
export const RepoRef = z.string().min(1).max(300);
export type RepoRef = z.infer<typeof RepoRef>;

/**
 * What an edge says about its two repos (ADR-116): `depends-on` the first needs the second to build (a package), `calls`
 * the first calls the second at runtime (HTTP). Only `calls` edges matter for starting a slice of services (ADR-45).
 * Topics will come with card extractors.
 */
export const EdgeKind = z.enum(["depends-on", "calls"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/**
 * Where an edge comes from (ADR-116): `package` from the cards (a repo uses a package the other builds, always
 * `depends-on`), `http` from the cards (a repo's HTTP client calls the other's application or endpoint, always `calls`),
 * `manual` from an entry in `workspace.yaml` (either kind).
 */
export const EdgeSource = z.enum(["package", "http", "manual"]);
export type EdgeSource = z.infer<typeof EdgeSource>;

/** A manual edge: a connection the cards do not see (for example an HTTP call through a gateway). */
export const ManualEdge = z
  .object({
    /** The repo that uses (calls, depends on). */
    from: RepoRef,
    /** The repo that `from` uses. */
    to: RepoRef,
    /** A description of the connection for a person and an agent, for example `HTTP /api/orders`. */
    note: z.string().min(1).max(200),
    /** What the connection is (ADR-116); without it `calls`, the connection manual edges were written for before. */
    kind: EdgeKind.default("calls"),
  })
  .strict();
export type ManualEdge = z.infer<typeof ManualEdge>;

/**
 * The `graph` key in `workspace.yaml` (ADR-29), only by hand in the file, because only the user knows the connections
 * between work repos (ADR-7). `packages`: a package alias, that is a package name (`group:artifact`, an npm name) and the
 * repo that provides it, when that repo's card does not show it (a package built outside the build files, a different
 * name in the artifact repository). `apps`: an application alias, that is an application name or a host from an HTTP
 * client's address (`orders`, `orders.internal.example.com`) and the repo that serves it, when no card has an
 * application of that name (a cluster DNS name other than `spring.application.name`, a gateway). `edges`: manual edges.
 */
export const GraphConfig = z
  .object({
    // YAML reads an empty subkey (`packages:` with commented-out entries) as `null`, like a missing key.
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
 * Edge confidence. Package: `exact` when exactly one repo builds it; `high` from a package alias; `medium` when several
 * repos in the list build it (for example two clones of one repo). HTTP (ADR-30): `exact` when the application name
 * points to one repo and every call has an endpoint in it; `high` for the application name alone or from an application
 * alias; `medium` for a host equal to the repo name, an application port on `localhost`, paths matching the endpoints of
 * one repo, or a name in several repos; `low` for paths matching the endpoints of several repos. A manual edge is `exact`.
 */
export const EdgeConfidence = z.enum(["exact", "high", "medium", "low"]);
export type EdgeConfidence = z.infer<typeof EdgeConfidence>;

/**
 * Edge evidence: a place in a repo (file and line in the card's commit) or in `workspace.yaml` (`repo: null`, full
 * path), with a sentence saying what at that place points to the connection, for example
 * `uses com.example:orders-client (compile)`.
 */
export const EdgeEvidence = MechanismEvidence.extend({ repo: RepoId.nullable() });
export type EdgeEvidence = z.infer<typeof EdgeEvidence>;

/** An edge from the repo that uses to the repo that is used. */
export const GraphEdge = z.object({
  from: RepoId,
  to: RepoId,
  kind: EdgeKind,
  source: EdgeSource,
  /** The package name for `package`, the application name or client address for `http`, the description from `workspace.yaml` for `manual`. */
  key: z.string(),
  confidence: EdgeConfidence,
  evidence: z.array(EdgeEvidence).min(1),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** A repo as a graph node. */
export const GraphNode = z.object({
  repo: RepoId,
  /** The remote address (`host/path`); `null` without a remote. */
  remote: z.string().nullable(),
  tags: z.array(TagName),
  /** How many packages the repo builds; `null` when the card cannot be computed. */
  provides: z.number().int().nonnegative().nullable(),
  /** Spring Boot application names from the card (ADR-30). */
  apps: z.array(z.string()),
  /** How many HTTP endpoints the repo provides; `null` when the card cannot be computed. */
  endpoints: z.number().int().nonnegative().nullable(),
  /** The reason there is no card (git cannot read the repo); then the repo is in the graph without edges from cards. */
  problem: z.string().nullable(),
});
export type GraphNode = z.infer<typeof GraphNode>;

/**
 * What kind of gap a graph problem is (ADR-116), like the codes of card problems (ADR-80): `unresolved-call-target` an
 * HTTP client with calls or an app name whose target no repo in the list is (an external system, or an app the graph
 * needs an alias in `graph.apps` for).
 */
export const GraphProblemCode = z.enum(["unresolved-call-target"]);
export type GraphProblemCode = z.infer<typeof GraphProblemCode>;

/** A gap the graph found in one repo's facts; it needs every card, so it is not on a card of one commit. */
export const GraphProblem = z.object({
  code: GraphProblemCode,
  repo: RepoId,
  via: HttpClientVia,
  /** The client name from the card. */
  client: z.string(),
  /** Where the client is in the repo's commit. */
  evidence: Evidence,
  message: z.string(),
});
export type GraphProblem = z.infer<typeof GraphProblem>;

/** The whole graph: nodes in the order of the repo list, edges, gaps, and errors in `graph` entries of `workspace.yaml`. */
export const RepoGraph = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  /** Gaps in the repos' facts found while joining the cards (ADR-116), in the order of the repo list. */
  problems: z.array(GraphProblem),
  /** A `graph` entry in `workspace.yaml` that cannot be used (for example a repo not in the list), as a sentence for a person. */
  configProblems: z.array(z.string()),
  /** The full path of `workspace.yaml`, where package aliases and manual edges are added. */
  configFile: z.string(),
});
export type RepoGraph = z.infer<typeof RepoGraph>;

/** The farthest neighbourhood in `subgraph_for`: beyond it a company graph is usually the whole graph, and the result no longer fits an agent's context. */
export const MAX_SUBGRAPH_DEPTH = 3;

/** A part of the graph around one repo. */
export const Subgraph = z.object({
  repo: RepoId,
  depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  /** The graph's problems in the subgraph's repos (ADR-116). */
  problems: z.array(GraphProblem),
});
export type Subgraph = z.infer<typeof Subgraph>;

export const WhoCallsResult = z.object({
  repo: RepoId,
  /** Edges into this repo: who uses it, what (the key) and how that is known (evidence). */
  edges: z.array(GraphEdge),
});
export type WhoCallsResult = z.infer<typeof WhoCallsResult>;

/** The most endpoints in a `find_endpoint` result: more does not fit an agent's context sensibly. */
export const MAX_FOUND_ENDPOINTS = 50;

/** An endpoint by its method, full path and handler, as on its repo card. */
export const EndpointRef = z.object({ method: HttpMethod.nullable(), path: z.string(), handler: z.string().nullable() });
export type EndpointRef = z.infer<typeof EndpointRef>;

/** A repo whose HTTP client calls the found endpoint (ADR-30). */
export const EndpointCaller = z.object({
  repo: RepoId,
  via: HttpClientVia,
  /** The client name from the card (a Feign interface, a class with calls). */
  client: z.string(),
  method: HttpMethod.nullable(),
  /** The full call path (the path from the client address plus the call path). */
  path: z.string(),
  confidence: EdgeConfidence,
  evidence: Evidence,
  /**
   * The caller repo's endpoints whose handlers reach this call (ADR-82): `[]` when none does (a scheduled job, a
   * listener or startup code makes the call), `null` when the caller's card could not trace or some endpoint of the
   * caller repo has no reach (`ProvidedEndpoint.reaches`), because that endpoint might make the call.
   */
  from: z.array(EndpointRef).nullable(),
});
export type EndpointCaller = z.infer<typeof EndpointCaller>;

/** An endpoint of another repo that an endpoint's handler calls (ADR-82), with the confidence of the client's target. */
export const EndpointCallee = EndpointRef.extend({
  repo: RepoId,
  via: HttpClientVia,
  client: z.string(),
  confidence: EdgeConfidence,
  /** The call's file and line in the calling repo. */
  evidence: Evidence,
});
export type EndpointCallee = z.infer<typeof EndpointCallee>;

/**
 * How a found endpoint matches the `find_endpoint` query (ADR-87), from the best: `path` the whole path (variables match
 * any segment), `path-end` the end of one path is the other one (the query lacks the context path or prefix the card has,
 * or has a gateway prefix the card does not), `text` every word of the query is in the path, handler, app or OpenAPI
 * operation id or summary.
 */
export const EndpointMatch = z.enum(["path", "path-end", "text"]);
export type EndpointMatch = z.infer<typeof EndpointMatch>;

/** An endpoint from a repo card that matches the query, with the repos that call it. */
export const FoundEndpoint = z.object({
  repo: RepoId,
  match: EndpointMatch,
  app: z.string().nullable(),
  method: HttpMethod.nullable(),
  path: z.string(),
  handler: z.string().nullable(),
  /** Whether the endpoint is a mapping in the code or only an operation in an OpenAPI spec (ADR-87). */
  source: EndpointSource,
  /** The OpenAPI operation describing the endpoint (ADR-87). */
  operation: OpenApiOperation.nullable(),
  /** The request and response body types from the card (ADR-38). */
  request: z.string().nullable(),
  response: z.string().nullable(),
  evidence: Evidence,
  callers: z.array(EndpointCaller),
  /** The endpoints of other repos this endpoint's handler calls (ADR-82); `null` when its card could not trace. */
  calls: z.array(EndpointCallee).nullable(),
});
export type FoundEndpoint = z.infer<typeof FoundEndpoint>;

export const FindEndpointResult = z.object({
  query: z.string(),
  endpoints: z.array(FoundEndpoint),
  /** More matched than `MAX_FOUND_ENDPOINTS`; narrow the query. */
  truncated: z.boolean(),
});
export type FindEndpointResult = z.infer<typeof FindEndpointResult>;

/** At most this many changed endpoints in `get_changed_endpoints`; more is a generated API, not one change. */
export const MAX_CHANGED_ENDPOINTS = 100;

/** An endpoint's contract on one side of a change: its handler and its request and response types (ADR-38). */
export const EndpointContract = z.object({
  handler: z.string().nullable(),
  request: z.string().nullable(),
  response: z.string().nullable(),
});
export type EndpointContract = z.infer<typeof EndpointContract>;

/**
 * An endpoint a task's commits add, remove or change (ADR-145), known by its app, method and path (and its handler when
 * several endpoints share them): a changed path is a removed endpoint and an added one. `changed` is a request or
 * response type that changed, or a DTO reachable from them whose fields or constants changed.
 */
export const EndpointChange = z.object({
  change: z.enum(["added", "removed", "changed"]),
  app: z.string().nullable(),
  method: HttpMethod.nullable(),
  path: z.string(),
  /** `null` for an added endpoint. */
  before: EndpointContract.nullable(),
  /** `null` for a removed endpoint. */
  after: EndpointContract.nullable(),
  /** The DTOs reachable from the endpoint's request or response whose fields or constants changed, appeared or went. */
  dtos: z.array(z.string()),
});
export type EndpointChange = z.infer<typeof EndpointChange>;

export const ChangedEndpoint = EndpointChange.extend({
  /**
   * The repos whose HTTP clients call the endpoint as the repo root's HEAD has it (the graph, like in `find_endpoint`);
   * `[]` for an added one.
   */
  callers: z.array(EndpointCaller),
});
export type ChangedEndpoint = z.infer<typeof ChangedEndpoint>;

/** A problem of the card of the task's base or head commit. */
export const ChangeCardProblem = CardProblem.extend({ commit: z.enum(["base", "head"]) });
export type ChangeCardProblem = z.infer<typeof ChangeCardProblem>;

/** What comparing the cards of a task's base and head gives (ADR-145), before the graph adds the callers. */
export const EndpointChanges = z.object({
  /** The commit of the task's HEAD the endpoints were read from; uncommitted work is not in it. */
  head: CommitHash,
  changes: z.array(EndpointChange),
  /**
   * `false` when a card was not fully parsed or was cut (`parse-incomplete` or `truncated` problems): then contracts and
   * DTOs are not compared, which would report endpoints as changed only because one card lacks them, and only added and
   * removed endpoints are listed.
   */
  contractsCompared: z.boolean(),
  /** What either card could not read, so a change there may be missing. */
  problems: z.array(ChangeCardProblem),
});
export type EndpointChanges = z.infer<typeof EndpointChanges>;

/** The endpoints a task's commits change against its base commit (`get_changed_endpoints`, ADR-145). */
export const ChangedEndpoints = EndpointChanges.omit({ changes: true }).extend({
  repo: RepoId,
  base: CommitHash,
  endpoints: z.array(ChangedEndpoint),
  /** More changed than `MAX_CHANGED_ENDPOINTS`. */
  truncated: z.boolean(),
});
export type ChangedEndpoints = z.infer<typeof ChangedEndpoints>;

const endpoint = apiEndpoints("graph");

export const graphApi = {
  /** The graph of all repos in the projects folder, computed from the cards (the first request for a commit reads the files from git). */
  graph: endpoint("graph", z.object({}).strict(), RepoGraph),
};

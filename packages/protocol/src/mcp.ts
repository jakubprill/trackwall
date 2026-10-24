import { z } from "zod";
import { RepoCardResult, TagName } from "./cards.ts";
import { FindEndpointResult, MAX_FOUND_ENDPOINTS, MAX_SUBGRAPH_DEPTH, Subgraph, WhoCallsResult } from "./graph.ts";
import { HttpMethod } from "./http.ts";
import { LOG_BUFFER_RECORDS, LOG_TAIL_MAX, LogTail } from "./logs.ts";
import { MiseTaskName, MiseTasks } from "./mise.ts";
import { SyncRepo } from "./sync.ts";
import { Commit, Repo, RepoId, RepoOverview } from "./workspace.ts";

/**
 * Kontrakt narzędzi MCP daemona (§5.3, ADR-24): nazwa, opis dla agenta, wejście i wynik każdego narzędzia w jednym
 * obiekcie `McpTool`, tak jak `Endpoint` dla API. Daemon ogłasza z nich `tools/list` i sprawdza nimi argumenty oraz
 * `structuredContent`, a testy, UI i klienty biorą z nich nazwy i parsują odpowiedź. Narzędzia tylko czytają; nazwy
 * narzędzi i pól po angielsku, opisy po polsku (AGENTS.md).
 */

/** Nazwa serwera MCP w `initialize` i w konfiguracji Copilot CLI (`copilot mcp add trackwall …`). */
export const MCP_SERVER_NAME = "trackwall";

/**
 * Wpis serwera MCP Trackwall w formacie konfiguracji MCP Copilot CLI (`mcp-config.json`, `--additional-mcp-config`):
 * lokalny serwer uruchamiany komendą mostu stdio (`mcpStdioCommand`), ze wszystkimi narzędziami.
 */
export function copilotMcpServers(mcpStdioCommand: readonly string[]) {
  const [command, ...args] = mcpStdioCommand;
  return { mcpServers: { [MCP_SERVER_NAME]: { type: "local", command, args, tools: ["*"] } } };
}

/** Wynik repo w ostatniej synchronizacji i kiedy ta synchronizacja trwała. */
const LastSync = z.object({
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null`, dopóki synchronizacja trwa. */
  finishedAt: z.string().nullable(),
  result: SyncRepo,
});

/**
 * Repo z listy (`Repo`) dla agenta: wynik w ostatniej synchronizacji od startu daemona (`null`, gdy go w niej nie
 * było) i nazwy tagów repo (ADR-25).
 */
export const AgentRepo = Repo.extend({ lastSync: LastSync.nullable(), tags: z.array(TagName) });
export type AgentRepo = z.infer<typeof AgentRepo>;

export const ListReposResult = z.object({
  /** Pełna ścieżka folderu z projektami; `null`, dopóki użytkownik go nie ustawi, a wtedy lista jest pusta. */
  projectsDir: z.string().nullable(),
  repos: z.array(AgentRepo),
});
export type ListReposResult = z.infer<typeof ListReposResult>;

export const GetRepoResult = z.object({
  repo: AgentRepo,
  /** README z commita HEAD, przycięte dla kontekstu agenta; `null`, gdy repo go nie ma. */
  readme: RepoOverview.shape.readme,
  /** Ostatnie commity, od najnowszego. */
  commits: z.array(Commit),
  /** Taski mise repo albo powód, dla którego mise ich nie podał (`not_installed`, `untrusted`, `error`). */
  miseTasks: MiseTasks,
});
export type GetRepoResult = z.infer<typeof GetRepoResult>;

export interface McpTool<Args extends z.ZodObject = z.ZodObject, Result extends z.ZodObject = z.ZodObject> {
  name: string;
  /** Opis dla modelu agenta: co zwraca i kiedy go użyć. */
  description: string;
  args: Args;
  result: Result;
}

const LIST_REPOS = "list_repos";
const GET_REPO = "get_repo";
const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);

export const mcpTools = {
  listRepos: {
    name: LIST_REPOS,
    description:
      "Repos in the user's projects folder: id, path, remote address (host/path), branch, latest commit, number of " +
      "local changes, ahead/behind, the result of the latest sync since Trackwall started (lastSync: null when there " +
      "was none) and repo tags (e.g. java, frontend, bff, monorepo and tags from the user's rules). The tags argument " +
      "narrows the list to repos with every given tag. Start with this tool; pass the id field to the other tools.",
    args: z
      .object({
        tags: z.array(TagName).max(20).optional().describe('only repos with every one of these tags, without #, e.g. ["java", "bff"]'),
      })
      .strict(),
    result: ListReposResult,
  },
  getRepo: {
    name: GET_REPO,
    description:
      `Details of one repo: the same as ${LIST_REPOS} (with tags; empty when the card cannot be built), the README from the latest commit (truncated), ` +
      "recent commits and mise tasks (name, description, run state) or the reason mise did not list them.",
    args: z.object({ repo: RepoArg }).strict(),
    result: GetRepoResult,
  },
  getRepoCard: {
    name: "get_repo_card",
    description:
      "Repo card built from the build files, config and code in the latest commit, every fact with evidence (file and " +
      "line). provides: packages (kind package: Maven group:artifact coordinates, npm names), Spring Boot apps (kind app: " +
      "spring.application.name, port) and HTTP endpoints from controllers (kind endpoint: method, full path, handler). " +
      "consumes: packages with scope and HTTP clients (kind http: Feign, @HttpExchange, WebClient, RestClient, " +
      "RestTemplate, addresses from application*.yml in every Spring profile, .env and the frontend proxy; with the app " +
      "name or address and the calls). Also required tool versions, detected mechanisms (Spring Boot, Feign, Kafka, " +
      "Eureka, Kubernetes…) and tags with reasons. card: null in a repo without commits.",
    args: z.object({ repo: RepoArg }).strict(),
    result: RepoCardResult,
  },
  tail: {
    name: "tail",
    description:
      "Log of a repo's mise task (stdout and stderr, oldest first): records with a seq number, run (runId), stream, " +
      "level from the line text (error, warn, info…) and text without colors, with secrets replaced by ***. Without " +
      "sinceSeq it returns the latest records; then pass nextSeq from the previous response as sinceSeq to get only " +
      `new ones. dropped: true means some records were lost (the daemon keeps the latest records of a task, at most ${LOG_BUFFER_RECORDS}) ` +
      `or the cursor is from a previous Trackwall run. ${GET_REPO} lists the tasks and their state.`,
    args: z
      .object({
        repo: RepoArg,
        miseTask: MiseTaskName.describe(`mise task name from ${GET_REPO} (the miseTasks field)`),
        sinceSeq: z.number().int().nonnegative().optional().describe("nextSeq from the previous response"),
        limit: z.number().int().min(1).max(LOG_TAIL_MAX).describe(`maximum number of records (up to ${LOG_TAIL_MAX})`),
      })
      .strict(),
    result: LogTail,
  },
  whoCalls: {
    name: "who_calls",
    description:
      "Who uses a repo: connection graph edges pointing to this repo, each with a kind (package: a repo uses a " +
      "package built in this repo; http: a repo's HTTP client calls this repo's app or endpoints; manual: a connection " +
      "entered by the user), a key (package name, app name or address, note), a confidence (exact, high, medium, low) " +
      "and evidence (repo, file, line; for http also call–endpoint pairs). Before changing a repo's API or package, " +
      "check whom it affects; find_endpoint tells who calls a specific endpoint.",
    args: z.object({ repo: RepoArg }).strict(),
    result: WhoCallsResult,
  },
  subgraphFor: {
    name: "subgraph_for",
    description:
      "Part of the connection graph around a repo: repos up to depth edges away in both directions (what it uses and " +
      "who uses it) and the edges between them (packages, HTTP, manual), with evidence. A node has tags, Spring Boot " +
      "app names, the number of endpoints and a problem when the repo card cannot be built.",
    args: z
      .object({
        repo: RepoArg,
        depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH).default(1).describe("how many edges from the repo, default 1"),
      })
      .strict(),
    result: Subgraph,
  },
  findEndpoint: {
    name: "find_endpoint",
    description:
      "HTTP endpoints from Spring controllers in all repos matching the query: a path starting with / (also a concrete " +
      "one: /api/orders/42 finds /api/orders/{id}) or part of a path, handler name (Class.method) or app name. Each " +
      "with repo, method, full path, file and line, plus callers: repos whose HTTP clients call it, with confidence " +
      `and evidence. At most ${MAX_FOUND_ENDPOINTS} results (truncated: true when there were more).`,
    args: z
      .object({
        query: z.string().min(1).max(300).describe("path or part of it, e.g. /api/orders/{id}, orders, OrdersController"),
        method: HttpMethod.optional().describe("only endpoints of this HTTP method (and those without a method)"),
      })
      .strict(),
    result: FindEndpointResult,
  },
} satisfies Record<string, McpTool>;

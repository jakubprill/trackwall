import { z } from "zod";
import { Session, SessionId, TASK_SUMMARY_MAX_FILES, Task, TaskChangesSummary } from "./agents.ts";
import { RepoCardResult, TagName } from "./cards.ts";
import { CODE_SEARCH_LINE_MAX_CHARS, CODE_SEARCH_MAX_MATCHES, CodeQuery, SearchCodeResult } from "./code-search.ts";
import { FindEndpointResult, MAX_FOUND_ENDPOINTS, MAX_SUBGRAPH_DEPTH, Subgraph, WhoCallsResult } from "./graph.ts";
import { HttpMethod } from "./http.ts";
import { LOG_BUFFER_RECORDS, LOG_ERRORS_MAX, LOG_TAIL_MAX, LogErrorLevel, LogErrors, LogTail } from "./logs.ts";
import { MiseTaskName, MiseTasks } from "./mise.ts";
import { RunState } from "./procs.ts";
import { SyncRepo } from "./sync.ts";
import { Commit, Repo, RepoId, RepoOverview } from "./workspace.ts";

/**
 * Kontrakt narzędzi MCP daemona (§5.3, ADR-24): nazwa, opis dla agenta, wejście i wynik każdego narzędzia w jednym
 * obiekcie `McpTool`, tak jak `Endpoint` dla API. Daemon ogłasza z nich `tools/list` i sprawdza nimi argumenty oraz
 * `structuredContent`, a testy, UI i klienty biorą z nich nazwy i parsują odpowiedź. Narzędzia tylko czytają; nazwy
 * narzędzi, pól i opisy po angielsku (ADR-32).
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

const [RunningSession, StoppingSession, ExitedSession] = RunState.options;

/**
 * Sesja dla agenta: to samo co `Session`, ale zakończona grupa procesów bez ostatnich linii ekranu: są
 * maskowane tylko wartościami sekretów ze środowiska procesu (§4.2), a agent wypisuje w terminalu także to, co przeczytał
 * z plików albo dostał w poleceniu, więc ekran jednej sesji nie trafia do innej (§8, ADR-36).
 */
export const AgentSession = Session.extend({
  run: z.discriminatedUnion("kind", [RunningSession, StoppingSession, ExitedSession.omit({ lastLines: true })]),
});
export type AgentSession = z.infer<typeof AgentSession>;

export const ListSessionsResult = z.object({
  /** Sesje od najnowszej, także zakończone, dopóki użytkownik ich nie zamknie. */
  sessions: z.array(AgentSession),
  /** Zadania od najnowszego; sesja zadania ma jego identyfikator w `Session.task`. */
  tasks: z.array(Task),
});
export type ListSessionsResult = z.infer<typeof ListSessionsResult>;

export const GetSessionResult = z.object({
  session: AgentSession,
  /** Zadanie sesji; `null` dla sesji w korzeniu repo. */
  task: Task.nullable(),
  /** Zmiany zadania względem commita bazowego; `null` dla sesji w korzeniu repo i gdy nie dało się ich policzyć. */
  changes: TaskChangesSummary.nullable(),
  /** Dlaczego zmian zadania nie ma (`<kod>: <komunikat>`, np. worktree usunięty ręcznie); `null`, gdy są albo sesja nie ma zadania. */
  changesError: z.string().nullable(),
});
export type GetSessionResult = z.infer<typeof GetSessionResult>;

export interface McpTool<Args extends z.ZodObject = z.ZodObject, Result extends z.ZodObject = z.ZodObject> {
  name: string;
  /** Opis dla modelu agenta: co zwraca i kiedy go użyć. */
  description: string;
  args: Args;
  result: Result;
}

const LIST_REPOS = "list_repos";
const GET_REPO = "get_repo";
const LIST_SESSIONS = "list_sessions";
const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);
const RepoTagsArg = z.array(TagName).max(20);

export const mcpTools = {
  listRepos: {
    name: LIST_REPOS,
    description:
      "Repos in the user's projects folder: id, path, remote address (host/path), branch, latest commit, number of " +
      "local changes (untracked: how many of them are new), ahead/behind, the result of the latest sync since Trackwall started (lastSync: null when there " +
      "was none) and repo tags (e.g. java, frontend, bff, monorepo, no-mise for a repo without mise tasks, and tags from the user's rules). The tags argument " +
      "narrows the list to repos with every given tag. Start with this tool; pass the id field to the other tools.",
    args: z
      .object({
        tags: RepoTagsArg.optional().describe('only repos with every one of these tags, without #, e.g. ["java", "bff"]'),
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
      "spring.application.name, port) and HTTP endpoints from controllers (kind endpoint: method, full path, handler, " +
      "request body type and response type). dtos: the request and response types declared in the repo and the types " +
      "of their fields (records, data classes, classes with fields, enums with values). " +
      "consumes: packages with scope and HTTP clients (kind http: Feign, @HttpExchange, WebClient, RestClient, " +
      "RestTemplate, addresses from application*.yml in every Spring profile, .env and the frontend proxy; with the app " +
      "name or address and the calls). Also required tool versions, detected mechanisms (Spring Boot, Feign, Kafka, " +
      "Eureka, Kubernetes…), the mise config files and mise tasks declared in the commit (mise) and tags with reasons. " +
      "card: null in a repo without commits.",
    args: z.object({ repo: RepoArg }).strict(),
    result: RepoCardResult,
  },
  tail: {
    name: "tail",
    description:
      "Log of a repo's mise task (stdout and stderr, oldest first): records with a seq number, run (runId), stream, " +
      "level from the line text (error, warn, info…) and text without colors, with secrets replaced by ***. Without " +
      "sinceSeq it returns the latest records; then pass nextSeq from the previous response as sinceSeq to get only " +
      `new ones. dropped: true means some records were lost (the daemon keeps the latest records of a mise task, at most ${LOG_BUFFER_RECORDS}) ` +
      `or the cursor is from a previous Trackwall run. ${GET_REPO} lists the mise tasks and their state.`,
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
  getErrors: {
    name: "get_errors",
    description:
      "Errors from the logs of mise tasks and mise install in all repos (or one repo or one mise task), the most recent first: " +
      "a line with ERROR/FATAL (or WARN with minLevel warn), a compiler error (javac, tsc, kotlinc, Maven [ERROR], npm error) " +
      "or an exception header together with the lines that belong to it: Java and Node stack traces with Caused by, the " +
      "Spring Boot APPLICATION FAILED TO START report and the Gradle FAILURE report. Each error has its source (repo, mise " +
      "task), run (runId), exception (the root cause: the last Caused by or the first exception header; null without one), " +
      "lines (from each stack trace the first frames, the rest replaced by a line '… N frames omitted'; omittedLines counts what is left out), seq and time. " +
      "The same error repeated in one source (same exception and first frame, or same lines; ids, numbers and thread names ignored, file " +
      "locations not) is one entry with count and firstTs. An error still being written when you call is returned with the lines it had then. " +
      `Only the latest records are kept (at most ${LOG_BUFFER_RECORDS} per mise task, since Trackwall started). Pass nextSeq as sinceSeq ` +
      "to get only errors that started after the previous call; dropped: true as in tail. To read the log of a mise task from an error on, " +
      "call tail with sinceSeq one less than the error's seq.",
    args: z
      .object({
        repo: RepoArg.optional(),
        miseTask: MiseTaskName.optional().describe(`only the log of this mise task (from ${GET_REPO}, the miseTasks field)`),
        minLevel: LogErrorLevel.default("error").describe("error (default) or warn to include warnings"),
        sinceSeq: z.number().int().nonnegative().optional().describe("nextSeq from the previous response"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LOG_ERRORS_MAX)
          .default(20)
          .describe(`maximum number of errors (default 20, up to ${LOG_ERRORS_MAX})`),
      })
      .strict(),
    result: LogErrors,
  },
  whoCalls: {
    name: "who_calls",
    description:
      "Who uses a repo: connections in the graph pointing to this repo, each with a kind (package: a repo uses a " +
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
      "Part of the connection graph around a repo: repos up to depth connections away in both directions (what it uses and " +
      "who uses it) and the connections between them (packages, HTTP, manual), with evidence. A node has tags, Spring Boot " +
      "app names, the number of endpoints and a problem when the repo card cannot be built.",
    args: z
      .object({
        repo: RepoArg,
        depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH).default(1).describe("how many connections from the repo, default 1"),
      })
      .strict(),
    result: Subgraph,
  },
  findEndpoint: {
    name: "find_endpoint",
    description:
      "HTTP endpoints from Spring controllers in all repos matching the query: a path starting with / (also a concrete " +
      "one: /api/orders/42 finds /api/orders/{id}) or part of a path, handler name (Class.method) or app name. Each " +
      "with repo, method, full path, request and response types, file and line, plus callers: repos whose HTTP clients call it, with confidence " +
      `and evidence. At most ${MAX_FOUND_ENDPOINTS} results (truncated: true when there were more).`,
    args: z
      .object({
        query: z.string().min(1).max(300).describe("path or part of it, e.g. /api/orders/{id}, orders, OrdersController"),
        method: HttpMethod.optional().describe("only endpoints of this HTTP method (and those without a method)"),
      })
      .strict(),
    result: FindEndpointResult,
  },
  searchCode: {
    name: "search_code",
    description:
      "Search code in many repos at once (git grep in each repo's latest commit, not in uncommitted changes): a fixed " +
      "string by default, a POSIX extended regular expression with regex: true (use [0-9] and [[:space:]], not \\d " +
      "or \\s). Each match has repo, path, line, " +
      `column, the line text (cut to ${CODE_SEARCH_LINE_MAX_CHARS} characters) and context lines before and after. ` +
      "Narrow with repos (ids), tags (every given tag) and paths (git pathspecs: *.java in any directory, src/, " +
      ":!*.test.ts to exclude). searched lists the repos with the commit searched; failed the repos git could not " +
      "search, with the reason (e.g. an invalid regular expression); skipped the repos not searched because the limit " +
      "was already reached or time ran out. truncated: true when matches may be missing (also per repo in searched); " +
      "narrow the query.",
    args: z
      .object({
        pattern: CodeQuery.shape.pattern.describe("text to find, or a regular expression with regex: true"),
        regex: CodeQuery.shape.regex.default(false).describe("pattern is a POSIX extended regular expression (git grep -E), default false"),
        ignoreCase: CodeQuery.shape.ignoreCase.default(false).describe("case-insensitive, default false"),
        repos: z.array(RepoId).min(1).max(200).optional().describe(`only these repos (ids from ${LIST_REPOS}); default all`),
        tags: RepoTagsArg.optional().describe('only repos with every one of these tags, without #, e.g. ["java"]'),
        paths: CodeQuery.shape.paths.default([]).describe('only these paths (git pathspecs), e.g. ["*.java", ":!src/test/"]'),
        context: CodeQuery.shape.context.default(2).describe("context lines before and after each match, default 2"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(CODE_SEARCH_MAX_MATCHES)
          .default(100)
          .describe(`maximum number of matches (up to ${CODE_SEARCH_MAX_MATCHES}), default 100`),
      })
      .strict(),
    result: SearchCodeResult,
  },
  listSessions: {
    name: LIST_SESSIONS,
    description:
      "Copilot CLI sessions that Trackwall runs (the Sessions view), newest first, and tasks. A session has an id, " +
      "repo, start time, process state (run: running, stopping, exited with exit code; the screen is not shared), the " +
      "latest state change (state: Working, Input, Approval, Plan, Done, Error, Stale, with source and confidence; " +
      "null before the first signal), window title (what the agent is working on), needsAttention (running and " +
      "waiting for the user: approval, plan approval, or an ended turn the user has not seen yet) and task: the id of the task whose worktree it runs in, null in the repo root. A task " +
      "is work in its own worktree on its own branch: prompt, branch, base branch and commit, worktree path. Sessions " +
      "end with Trackwall, tasks stay until the user ends them. The repo argument narrows both lists to one repo (not_found for an unknown repo). " +
      "The tool is read-only: only the user starts, answers and stops sessions.",
    args: z.object({ repo: RepoArg.optional() }).strict(),
    result: ListSessionsResult,
  },
  getSession: {
    name: "get_session",
    description:
      `One session from ${LIST_SESSIONS}, its task (null in the repo root) and, for a task, the changes in its ` +
      `worktree against the base commit: changed files with added and deleted lines (at most ${TASK_SUMMARY_MAX_FILES}, filesTruncated: ` +
      "true when there were more), commits on the task branch and the number of uncommitted entries, without the diff " +
      "itself; read the worktree for the content. changes: null with changesError when they cannot be computed " +
      "(e.g. the worktree was deleted or the task is being ended).",
    args: z.object({ session: SessionId.describe(`session id from ${LIST_SESSIONS} (the id field)`) }).strict(),
    result: GetSessionResult,
  },
} satisfies Record<string, McpTool>;

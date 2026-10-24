import { z } from "zod";
import {
  Session,
  SessionId,
  TASK_PROMPT_MAX,
  TASK_SUMMARY_MAX,
  TASK_SUMMARY_MAX_FILES,
  TASK_TITLE_MAX,
  Task,
  TaskChangesSummary,
  TaskId,
  TaskPrompt,
  TaskProposal,
  TaskSummaryText,
  TaskTitle,
} from "./agents.ts";
import { RepoCardResult, TagName } from "./cards.ts";
import { FindEndpointResult, MAX_FOUND_ENDPOINTS, MAX_SUBGRAPH_DEPTH, Subgraph, WhoCallsResult } from "./graph.ts";
import { HttpMethod } from "./http.ts";
import { LOG_BUFFER_RECORDS, LOG_TAIL_MAX, LogTail } from "./logs.ts";
import { MiseTaskName, MiseTasks } from "./mise.ts";
import { RunState } from "./procs.ts";
import { SyncRepo } from "./sync.ts";
import { Commit, Repo, RepoId, RepoOverview } from "./workspace.ts";

/**
 * Kontrakt narzędzi MCP daemona (§5.3, ADR-24): nazwa, opis dla agenta, wejście i wynik każdego narzędzia w jednym
 * obiekcie `McpTool`, tak jak `Endpoint` dla API. Daemon ogłasza z nich `tools/list` i sprawdza nimi argumenty oraz
 * `structuredContent`, a testy, UI i klienty biorą z nich nazwy i parsują odpowiedź. Narzędzia czytają, a te
 * z `readOnly: false` (ADR-39) tylko zgłaszają propozycję albo podsumowanie zadania: niczego nie uruchamiają, bo zadanie
 * startuje dopiero po zatwierdzeniu w UI. Nazwy narzędzi, pól i opisy po angielsku (ADR-32).
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
  /** Propozycje zadań czekające na decyzję użytkownika (ADR-39). */
  proposals: z.array(TaskProposal),
  /** Sesja, która woła narzędzie (po tokenie sesji); `null` dla agenta spoza Trackwall. */
  caller: SessionId.nullable(),
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

export const ProposeTaskResult = z.object({ proposal: TaskProposal });
export type ProposeTaskResult = z.infer<typeof ProposeTaskResult>;

export const ReportResultResult = z.object({ task: Task });
export type ReportResultResult = z.infer<typeof ReportResultResult>;

/**
 * Co zastało czekanie (`wait_for_session`, ADR-39). Czekanie trwa tylko w `proposal_pending`, `starting` i `working`,
 * a te stany w wyniku znaczą, że minął limit czasu; reszta kończy je od razu.
 */
export const WaitStatus = z.enum([
  /** Propozycja czeka na decyzję użytkownika. */
  "proposal_pending",
  /** Użytkownik odrzucił propozycję. */
  "proposal_rejected",
  /** Zadanie istnieje, a jego sesja jeszcze się uruchamia. */
  "starting",
  /** Sesja pracuje (albo jeszcze nie zgłosiła stanu). */
  "working",
  /** Sesja nie odpowiada (`Stale`). */
  "stale",
  /** Sesja czeka na użytkownika (`needsAttention`): skończyła turę, prosi o zgodę albo o akceptację planu. */
  "needs_attention",
  /** Proces sesji się zakończył. */
  "exited",
  /** Zadanie nie ma sesji (np. po restarcie Trackwall); użytkownik może je wznowić w UI. */
  "no_session",
]);
export type WaitStatus = z.infer<typeof WaitStatus>;

export const WaitForSessionResult = z.object({
  status: WaitStatus,
  /** Propozycja, gdy czekanie dotyczyło zadania, którego użytkownik jeszcze nie zatwierdził. */
  proposal: TaskProposal.nullable(),
  task: Task.nullable(),
  session: AgentSession.nullable(),
});
export type WaitForSessionResult = z.infer<typeof WaitForSessionResult>;

/** Najdłuższe czekanie w jednym wywołaniu: poniżej minuty, żeby klient MCP nie przerwał wywołania swoim limitem czasu. */
export const WAIT_MAX_SECONDS = 55;

export interface McpTool<Args extends z.ZodObject = z.ZodObject, Result extends z.ZodObject = z.ZodObject> {
  name: string;
  /** Opis dla modelu agenta: co zwraca i kiedy go użyć. */
  description: string;
  /** Narzędzie tylko czyta (`readOnlyHint`); `false` dla tych, które zapisują propozycję albo podsumowanie (ADR-39). */
  readOnly: boolean;
  args: Args;
  result: Result;
}

const LIST_REPOS = "list_repos";
const GET_REPO = "get_repo";
const LIST_SESSIONS = "list_sessions";
const GET_SESSION = "get_session";
const PROPOSE_TASK = "propose_task";
const REPORT_RESULT = "report_result";
const WAIT_FOR_SESSION = "wait_for_session";
const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);

export const mcpTools = {
  listRepos: {
    name: LIST_REPOS,
    readOnly: true,
    description:
      "Repos in the user's projects folder: id, path, remote address (host/path), branch, latest commit, number of " +
      "local changes (untracked: how many of them are new), ahead/behind, the result of the latest sync since Trackwall started (lastSync: null when there " +
      "was none) and repo tags (e.g. java, frontend, bff, monorepo, no-mise for a repo without mise tasks, and tags from the user's rules). The tags argument " +
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
    readOnly: true,
    description:
      `Details of one repo: the same as ${LIST_REPOS} (with tags; empty when the card cannot be built), the README from the latest commit (truncated), ` +
      "recent commits and mise tasks (name, description, run state) or the reason mise did not list them.",
    args: z.object({ repo: RepoArg }).strict(),
    result: GetRepoResult,
  },
  getRepoCard: {
    name: "get_repo_card",
    readOnly: true,
    description:
      "Repo card built from the build files, config and code in the latest commit, every fact with evidence (file and " +
      "line). provides: packages (kind package: Maven group:artifact coordinates, npm names), Spring Boot apps (kind app: " +
      "spring.application.name, port) and HTTP endpoints from controllers (kind endpoint: method, full path, handler). " +
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
    readOnly: true,
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
  whoCalls: {
    name: "who_calls",
    readOnly: true,
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
    readOnly: true,
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
    readOnly: true,
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
  listSessions: {
    name: LIST_SESSIONS,
    readOnly: true,
    description:
      "Copilot CLI sessions that Trackwall runs (the Sessions view), newest first, and tasks. A session has an id, " +
      "repo, start time, process state (run: running, stopping, exited with exit code; the screen is not shared), the " +
      "latest state change (state: Working, Input, Approval, Plan, Done, Error, Stale, with source and confidence; " +
      "null before the first signal), window title (what the agent is working on), needsAttention (running and " +
      "waiting for the user) and task: the id of the task whose worktree it runs in, null in the repo root. A task " +
      "is work in its own worktree on its own branch: prompt, branch, base branch and commit, worktree path. Sessions " +
      "end with Trackwall, tasks stay until the user ends them. Also task proposals waiting for the user's decision " +
      `(${PROPOSE_TASK}) and caller: your own session id when you run in Trackwall, null otherwise. The repo argument ` +
      "narrows the lists to one repo (not_found for an unknown repo). Only the user starts, answers and stops sessions.",
    args: z.object({ repo: RepoArg.optional() }).strict(),
    result: ListSessionsResult,
  },
  getSession: {
    name: GET_SESSION,
    readOnly: true,
    description:
      `One session from ${LIST_SESSIONS}, its task (null in the repo root) and, for a task, the changes in its ` +
      `worktree against the base commit: changed files with added and deleted lines (at most ${TASK_SUMMARY_MAX_FILES}, filesTruncated: ` +
      "true when there were more), commits on the task branch and the number of uncommitted entries, without the diff " +
      "itself; read the worktree for the content. changes: null with changesError when they cannot be computed " +
      "(e.g. the worktree was deleted or the task is being ended).",
    args: z.object({ session: SessionId.describe(`session id from ${LIST_SESSIONS} (the id field)`) }).strict(),
    result: GetSessionResult,
  },
  proposeTask: {
    name: PROPOSE_TASK,
    readOnly: false,
    description:
      "Propose a task for another agent: Trackwall shows it to the user in the Sessions view, and nothing runs until the " +
      "user approves it (the user may edit the prompt first, or reject it). An approved proposal becomes a task with the " +
      "same id: a new branch from the repo's default branch in its own worktree and a Copilot CLI session there with the " +
      "prompt as its first message. Write the prompt so that it stands alone (the agent sees nothing else), with the goal, " +
      `the relevant repos and files, and how to check the result; ask the agent to call ${REPORT_RESULT} when it is done. ` +
      `Then call ${WAIT_FOR_SESSION} with task: the returned id to learn about approval and the session.`,
    args: z
      .object({
        repo: RepoArg,
        title: TaskTitle.describe(
          `short single-line title for the task list, up to ${TASK_TITLE_MAX} characters, e.g. Add email validation to sign-up`,
        ),
        prompt: TaskPrompt.describe(`the complete instructions for the agent, up to ${TASK_PROMPT_MAX} characters`),
      })
      .strict(),
    result: ProposeTaskResult,
  },
  reportResult: {
    name: REPORT_RESULT,
    readOnly: false,
    description:
      "Report the result of your task: what you did, what is left and what the user or the session that proposed the " +
      `task should check. Only for a session that runs a task in Trackwall; the summary is saved to your own task (shown in ${GET_SESSION}, ` +
      `${LIST_SESSIONS} and the Sessions view). Calling it again replaces the summary. Commit your changes on the task branch before reporting.`,
    args: z.object({ summary: TaskSummaryText.describe(`the result in a few sentences, up to ${TASK_SUMMARY_MAX} characters`) }).strict(),
    result: ReportResultResult,
  },
  waitForSession: {
    name: WAIT_FOR_SESSION,
    readOnly: true,
    description:
      `Wait until a session or task needs someone: pass session (id from ${LIST_SESSIONS}) or task (id from ${PROPOSE_TASK} ` +
      `or ${LIST_SESSIONS}). Returns as soon as the status is proposal_rejected, stale, needs_attention (the session ` +
      "finished its turn or asks the user for approval), exited or no_session, or after timeoutSeconds with " +
      "proposal_pending, starting or working; then call it again. Waiting on a task follows its latest session. " +
      `The result has the proposal, task (with its summary from ${REPORT_RESULT}) and session; ${GET_SESSION} gives the changed files.`,
    args: z
      .object({
        session: SessionId.optional().describe(`session id from ${LIST_SESSIONS}`),
        task: TaskId.optional().describe(`task or proposal id from ${PROPOSE_TASK} or ${LIST_SESSIONS}`),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(WAIT_MAX_SECONDS)
          .default(30)
          .describe(`how long to wait at most, up to ${WAIT_MAX_SECONDS} s, default 30`),
      })
      .strict()
      .refine((args) => (args.session === undefined) !== (args.task === undefined), "pass exactly one of session and task"),
    result: WaitForSessionResult,
  },
} satisfies Record<string, McpTool>;

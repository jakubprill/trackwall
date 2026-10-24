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
  visibleText,
} from "./agents.ts";
import { RepoCardResult, TagName } from "./cards.ts";
import { FindEndpointResult, MAX_FOUND_ENDPOINTS, MAX_SUBGRAPH_DEPTH, Subgraph, WhoCallsResult } from "./graph.ts";
import { HttpMethod } from "./http.ts";
import { LOG_BUFFER_RECORDS, LOG_ERRORS_MAX, LOG_TAIL_MAX, LogErrorLevel, LogErrors, LogTail } from "./logs.ts";
import { MiseTaskName, MiseTasks, RunningMiseTask } from "./mise.ts";
import { RunState } from "./procs.ts";
import { CallEndpointRequest, CallEndpointResult, MAX_SLICE_REPOS, SERVICE_MISE_TASK, Service, ServiceSlice } from "./services.ts";
import { SyncRepo } from "./sync.ts";
import { Commit, Repo, RepoId, RepoOverview } from "./workspace.ts";

/**
 * Kontrakt narzędzi MCP daemona (§5.3, ADR-24): nazwa, opis dla agenta, wejście i wynik każdego narzędzia w jednym
 * obiekcie `McpTool`, tak jak `Endpoint` dla API. Daemon ogłasza z nich `tools/list` i sprawdza nimi argumenty oraz
 * `structuredContent`, a testy, UI i klienty biorą z nich nazwy i parsują odpowiedź. Narzędzia czytają, a te
 * z `readOnly: false` zgłaszają propozycję albo podsumowanie zadania (ADR-39; zadanie startuje dopiero po zatwierdzeniu
 * w UI) albo uruchamiają i zatrzymują taski mise z zaufanej konfiguracji repo (ADR-41). Nazwy narzędzi, pól i opisy
 * po angielsku (ADR-32).
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

/** How long one waiting call waits (`wait_for_session`, `wait_for_mise_task`). */
const WaitTimeoutArg = z
  .number()
  .int()
  .min(1)
  .max(WAIT_MAX_SECONDS)
  .default(30)
  .describe(`how long to wait at most, up to ${WAIT_MAX_SECONDS} s, default 30`);

/** A mise task run after `run_mise_task`, `stop_mise_task` and `wait_for_mise_task` (ADR-41). */
export const MiseTaskRunResult = z.object({ run: RunState });
export type MiseTaskRunResult = z.infer<typeof MiseTaskRunResult>;

export const StartServiceResult = z.object({ slice: ServiceSlice });
export type StartServiceResult = z.infer<typeof StartServiceResult>;

export const StopServiceResult = z.object({
  /** The services stopped, each `stopped` with its last run. */
  services: z.array(Service),
});
export type StopServiceResult = z.infer<typeof StopServiceResult>;

export const ListServicesResult = z.object({ services: z.array(Service) });
export type ListServicesResult = z.infer<typeof ListServicesResult>;

export const ListRunningMiseTasksResult = z.object({
  /** mise tasks started in this Trackwall run (from the UI or over MCP) whose process group is still alive. */
  miseTasks: z.array(RunningMiseTask),
});
export type ListRunningMiseTasksResult = z.infer<typeof ListRunningMiseTasksResult>;

interface McpToolBase<Args extends z.ZodObject, Result extends z.ZodObject> {
  name: string;
  /** Opis dla modelu agenta: co zwraca i kiedy go użyć. */
  description: string;
  args: Args;
  result: Result;
}

/**
 * How a tool affects state; the daemon builds the MCP annotations from it. `readOnly` is `readOnlyHint`, and a tool
 * that changes state says explicitly whether it can destroy something outside Trackwall (`destructiveHint`): writing
 * text for a human cannot (ADR-39), running repo code or killing a process the user may need (a dev server, a
 * migration) can (ADR-41).
 */
type McpToolEffect<Args extends z.ZodObject> =
  | { readOnly: true }
  | { readOnly: false; destructive: false }
  | {
      readOnly: false;
      destructive: true;
      /**
       * The arguments the daemon log gets before the tool acts (ADR-41, until the `audit` table exists). Listed
       * explicitly, so a new destructive tool cannot log free text that may carry a secret (headers, a body) by default.
       */
      auditArgs: readonly (keyof z.output<Args> & string)[];
    };

export type McpTool<Args extends z.ZodObject = z.ZodObject, Result extends z.ZodObject = z.ZodObject> = McpToolBase<Args, Result> &
  McpToolEffect<Args>;

const LIST_REPOS = "list_repos";
const GET_REPO = "get_repo";
const LIST_SESSIONS = "list_sessions";
const GET_SESSION = "get_session";
const PROPOSE_TASK = "propose_task";
const REPORT_RESULT = "report_result";
const WAIT_FOR_SESSION = "wait_for_session";
const RUN_MISE_TASK = "run_mise_task";
const WAIT_FOR_MISE_TASK = "wait_for_mise_task";
const TAIL = "tail";
const RepoArg = RepoId.describe(`repo id from ${LIST_REPOS} (the id field)`);
const MiseTaskArg = MiseTaskName.describe(`mise task name from ${GET_REPO} (the miseTasks field)`);
/** Arguments of the tools that act on one mise task of a repo. */
const MiseTaskArgs = z.object({ repo: RepoArg, miseTask: MiseTaskArg }).strict();
const START_SERVICE = "start_service";
const CALL_ENDPOINT = "call_endpoint";
const GET_ERRORS = "get_errors";

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
    name: TAIL,
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
        miseTask: MiseTaskArg,
        sinceSeq: z.number().int().nonnegative().optional().describe("nextSeq from the previous response"),
        limit: z.number().int().min(1).max(LOG_TAIL_MAX).describe(`maximum number of records (up to ${LOG_TAIL_MAX})`),
      })
      .strict(),
    result: LogTail,
  },
  getErrors: {
    name: GET_ERRORS,
    readOnly: true,
    description:
      "Errors from the logs of mise tasks and mise install in all repos (or one repo or one mise task), the most recent first: " +
      "a line with ERROR/FATAL (or WARN with minLevel warn), a compiler error (javac, tsc, kotlinc, Maven [ERROR], npm error) " +
      "or an exception header together with the lines that belong to it: Java and Node stack traces with Caused by, the " +
      "Spring Boot APPLICATION FAILED TO START report and the Gradle FAILURE report. Each error has its source (repo, mise " +
      "task), run (runId), exception (the root cause: the last Caused by or the first exception header; null without one), " +
      "lines (from each stack trace the first frames, the rest replaced by a line '… N frames omitted'; omittedLines counts what is left out), seq and time. " +
      "The same error repeated in one source (same first line and exception, numbers ignored) is one entry with count and firstTs. " +
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
    destructive: false,
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
        title: visibleText(TaskTitle).describe(
          `short single-line title for the task list, up to ${TASK_TITLE_MAX} characters, e.g. Add email validation to sign-up`,
        ),
        prompt: visibleText(TaskPrompt).describe(`the complete instructions for the agent, up to ${TASK_PROMPT_MAX} characters`),
      })
      .strict(),
    result: ProposeTaskResult,
  },
  reportResult: {
    name: REPORT_RESULT,
    readOnly: false,
    destructive: false,
    description:
      "Report the result of your task: what you did, what is left and what the user or the session that proposed the " +
      `task should check. Only for a session that runs a task in Trackwall; the summary is saved to your own task (shown in ${GET_SESSION}, ` +
      `${LIST_SESSIONS} and the Sessions view). Calling it again replaces the summary. Commit your changes on the task branch before reporting.`,
    args: z
      .object({ summary: visibleText(TaskSummaryText).describe(`the result in a few sentences, up to ${TASK_SUMMARY_MAX} characters`) })
      .strict(),
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
        timeoutSeconds: WaitTimeoutArg,
      })
      .strict()
      .refine((args) => (args.session === undefined) !== (args.task === undefined), "pass exactly one of session and task"),
    result: WaitForSessionResult,
  },
  runMiseTask: {
    name: RUN_MISE_TASK,
    readOnly: false,
    destructive: true,
    auditArgs: ["repo", "miseTask"] as const,
    description:
      "Run a repo's mise task (mise run <task>) in the repo root in the user's projects folder, not in a task worktree, " +
      `the same as the Run button in Trackwall. Only tasks listed by ${GET_REPO} (miseTasks) can run; a task that is ` +
      "already running is not started again, and the result is its current run. Returns run: running with runId. Then " +
      `call ${WAIT_FOR_MISE_TASK} to learn the exit code and ${TAIL} for the output (records of this run have its runId). ` +
      "A mise config the user has not trusted gives mise_unavailable: only the user can trust it, in Trackwall; ask them. " +
      "A session in Trackwall can run only mise tasks of its own repo. Long-running tasks (dev servers) keep running " +
      "until stopped; stop them when you no longer need them.",
    args: MiseTaskArgs,
    result: MiseTaskRunResult,
  },
  stopMiseTask: {
    name: "stop_mise_task",
    readOnly: false,
    destructive: true,
    auditArgs: ["repo", "miseTask"] as const,
    description:
      "Stop a running mise task of a repo, also one the user started in Trackwall: a gentle stop, then the whole " +
      "process group is killed. Returns after Trackwall has confirmed that no process of the group is alive " +
      "(run: exited with stoppedByUser: true); stop_unconfirmed when some process survived. A task that has already " +
      "ended returns its run; not_found when it has not been run since Trackwall started. A session in Trackwall can " +
      "stop only mise tasks of its own repo.",
    args: MiseTaskArgs,
    result: MiseTaskRunResult,
  },
  waitForMiseTask: {
    name: WAIT_FOR_MISE_TASK,
    readOnly: true,
    description:
      `Wait until a repo's mise task started with ${RUN_MISE_TASK} (or in Trackwall) ends: returns run: exited with ` +
      "the exit code (exitCode, signal, stoppedByUser) as soon as the process group has ended, or after timeoutSeconds " +
      "with run: running; then call it again. A task that has already ended returns its last run at once; not_found " +
      `when it has not been run since Trackwall started. ${TAIL} gives the output.`,
    args: MiseTaskArgs.extend({ timeoutSeconds: WaitTimeoutArg }),
    result: MiseTaskRunResult,
  },
  listRunningMiseTasks: {
    name: "list_running_mise_tasks",
    readOnly: true,
    description:
      "mise tasks running in all repos (also those being stopped) that Trackwall started since it started, from the " +
      `UI or with ${RUN_MISE_TASK}: repo, mise task name and run (runId, start time, pid). Cheap: it does not ask mise.`,
    args: z.object({}).strict(),
    result: ListRunningMiseTasksResult,
  },
  startService: {
    name: START_SERVICE,
    readOnly: false,
    destructive: true,
    auditArgs: ["repo", "dependencies"] as const,
    description:
      `Start a repo's service (its mise task ${SERVICE_MISE_TASK}, in the repo root) together with the services it calls, ` +
      "found in the connection graph (http and manual connections, not packages, not low confidence), dependencies " +
      "first: a repo starts once the repos it calls are up. A service is ready (healthy) when its port accepts a " +
      "connection: the port from its log (e.g. 'Tomcat started on port 8081') or server.port on its card. Waits up " +
      "to timeoutSeconds and returns the slice: each repo with calledBy (why it is in the slice), outcome (pending, " +
      "started, running: it was already running, skipped with problem: no mise task dev, mise config not trusted, " +
      "port taken by another process), service (state starting, healthy, unhealthy, crashed, stopped; port; run with " +
      "runId; reason) and, for crashed and unhealthy, errors from its log. settled: false means some are still " +
      "starting: call again with the same arguments to keep waiting (running services are not restarted; a crashed " +
      `one starts again, e.g. after you fixed it). At most ${MAX_SLICE_REPOS} repos. A session in Trackwall can start ` +
      `only its own repo (dependencies come from the graph). Then use ${CALL_ENDPOINT}; read logs with tail ` +
      `(miseTask ${SERVICE_MISE_TASK}) and ${GET_ERRORS}. Stop what you started with stop_service when you are done.`,
    args: z
      .object({
        repo: RepoArg,
        dependencies: z.boolean().default(true).describe("also start the services it calls (default true)"),
        timeoutSeconds: WaitTimeoutArg,
      })
      .strict(),
    result: StartServiceResult,
  },
  stopService: {
    name: "stop_service",
    readOnly: false,
    destructive: true,
    auditArgs: ["repo", "dependencies"] as const,
    description:
      "Stop a repo's service (its whole process group) and, with dependencies: true, the services the latest " +
      `${START_SERVICE} of this repo started (not those that were already running or that another started slice uses). ` +
      "Returns the stopped services. A session in Trackwall can stop only its own repo's service.",
    args: z
      .object({
        repo: RepoArg,
        dependencies: z.boolean().default(false).describe("also stop the dependencies its start started (default false)"),
      })
      .strict(),
    result: StopServiceResult,
  },
  listServices: {
    name: "list_services",
    readOnly: true,
    description:
      `Services Trackwall started or watched since it started (with ${START_SERVICE}, the UI, or the mise task ` +
      `${SERVICE_MISE_TASK} run from the UI): repo, state (starting, healthy, unhealthy, stopping, stopped, crashed), ` +
      "port and where it comes from (log or card), run (runId, pid or exit code) and reason. Cheap: it does not ask mise.",
    args: z.object({}).strict(),
    result: ListServicesResult,
  },
  callEndpoint: {
    name: CALL_ENDPOINT,
    readOnly: false,
    destructive: true,
    // The path (a query), headers and body may carry a secret.
    auditArgs: ["repo", "method"] as const,
    description:
      `Send an HTTP request to a running (healthy) service started by Trackwall, on its port on this computer ` +
      "(the path from the repo card's endpoints, find_endpoint or the code). Returns the status, response headers and " +
      "body (text, cut at 32 KB, secrets from the service environment masked), or failure (connection refused, " +
      "timeout), the duration and errors: error blocks that started in the logs of all services during the call and " +
      "half a second after it, with stack traces (as get_errors). Use it to check a change end to end: start_service, " +
      "call, read errors, fix, call again. Requests can change data in the services and their databases.",
    args: z
      .object({
        repo: RepoArg,
        method: CallEndpointRequest.shape.method.default("GET"),
        path: CallEndpointRequest.shape.path.describe("path with the query, e.g. /api/orders/42?expand=lines"),
        headers: CallEndpointRequest.shape.headers.default({}).describe('request headers, e.g. {"content-type": "application/json"}'),
        body: CallEndpointRequest.shape.body.default(null).describe("request body as text, e.g. JSON"),
        timeoutSeconds: WaitTimeoutArg,
      })
      .strict(),
    result: CallEndpointResult,
  },
} satisfies Record<string, McpTool>;

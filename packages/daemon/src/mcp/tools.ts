import type { McpServer } from "@modelcontextprotocol/server";
import {
  type AgentRepo,
  type AgentSession,
  ancestorsOf,
  childrenOf,
  compareSiblings,
  isSupervisor,
  type McpTool,
  type MiseTarget,
  mcpTools,
  miseTaskLogSource,
  type Repo,
  type RepoTags,
  type Session,
  type SyncRun,
} from "@trackwall/protocol";
import { z } from "zod";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { itemSummaries, matchesItem } from "./board-items.ts";

/**
 * The daemon's MCP tools (§5.3, ADR-24): each is a thin mapping onto the facade, so the agent sees the same state as the UI
 * (§1.1). None changes the configuration or a repo (§8), none answers in a session or stops one, and only `resume_task`
 * starts one: a new session of a task the user already approved, in its own worktree (ADR-90). Only
 * `propose_task` (a proposal, which only the user turns into a task in the UI), `report_result` (the summary of the
 * session's own task), ADR-39, and `create_item` and `update_item` (the user's board, from which nothing starts by
 * itself, ADR-133) write anything, `get_review_comments` marks the user's review comments read (ADR-62),
 * `send_message` queues text for the session of a task the caller proposed, and `get_messages` and `get_updates` mark
 * what they return read (ADR-68);
 * only `run_mise_task` and `stop_mise_task` start and stop processes: a mise task from the current list of the repo's
 * trusted configuration, like the button in the UI (ADR-41), and `verify_task` runs the mise task `test` the same way (ADR-64).
 * A tool that a session's untrusted mise config can refuse runs inside `agents.runNeedingMiseTrust`, so the session is told
 * when the user trusts it (ADR-92).
 */

/**
 * A README longer than this does not fit sensibly into the agent's context anyway (the result carries it twice: in the
 * text and in `structuredContent`); the preview limit in the UI (512 KB) is for a human who scrolls.
 */
const README_MAX_CHARS = 32_000;
/** How many recent commits `get_repo` returns: enough for the agent to know what has happened lately. */
const RECENT_COMMITS = 10;
/**
 * What a session may do only in its own repo, as the `bad_request` message of `assertCallerRepo` puts it: mise tasks
 * (ADR-41) and the service (ADR-45).
 */
const MISE_TASK_ACTION = "run and stop only mise tasks";
const SERVICE_ACTION = "start and stop only the service";
const VERIFY_ACTION = "verify only the tasks";

export interface ToolContext {
  facade: Facade;
  /**
   * A daemon log line about the call (tool, time, result), without arguments except for destructive tools (ADR-41);
   * the `audit` table will come with SQLite.
   */
  log: (msg: string) => void;
}

/** One call: the calling session (by session token, ADR-39; `null` for an agent outside Trackwall), and cancellation by the client. */
interface ToolCall {
  caller: string | null;
  signal: AbortSignal;
}

/** A tool's run on the facade: arguments and result have the types of the schemas from its contract. */
type ToolRun<Args extends z.ZodObject, Result extends z.ZodObject> = (
  facade: Facade,
  args: z.output<Args>,
  call: ToolCall,
) => Promise<z.input<Result>>;

/** Registers one tool in the MCP server created for one request of one session (`caller`). */
type ToolRegistration = (server: McpServer, ctx: ToolContext & { caller: string | null }) => void;

/**
 * A tool from the contract (`mcpTools` in protocol) and its run on the facade; the result must match the contract's
 * type, like the API routes in `api/routes.ts`.
 */
function defineTool<Args extends z.ZodObject, Result extends z.ZodObject>(
  tool: McpTool<Args, Result>,
  run: ToolRun<Args, Result>,
): ToolRegistration {
  // The SDK types the arguments from the schema's type and cannot do it from a generic parameter; so the arguments pass
  // through the tool's schema once more (the SDK already checks them before the call), which gives their exact type without a cast.
  const inputSchema: z.ZodObject = tool.args;
  const outputSchema: z.ZodObject = tool.result;
  return (server, ctx) => {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly && tool.destructive, openWorldHint: false },
      },
      async (args, extra) => {
        const started = Date.now();
        // The calling session goes into the log, because a proposal and a summary write something on its behalf; the `audit` table
        // will come with SQLite.
        const label = ctx.caller === null ? tool.name : `${tool.name} (session ${ctx.caller})`;
        try {
          const parsed = parseArgs(tool.args, args);
          // A destructive tool (it runs or stops repo code) logs its arguments before acting: until the `audit` table
          // exists, this line says who ran what (ADR-41). Their arguments are identifiers, never free text.
          if (!tool.readOnly && tool.destructive) ctx.log(`${label}: ${JSON.stringify(auditView(parsed, tool.auditArgs))}`);
          const result = tool.result.parse(await run(ctx.facade, parsed, { caller: ctx.caller, signal: extra.mcpReq.signal }));
          ctx.log(`${label}: ok in ${Date.now() - started} ms`);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          ctx.log(`${label}: error in ${Date.now() - started} ms: ${String(err)}`);
          return { content: [{ type: "text", text: toolErrorText(ctx.facade, tool.name, err) }], isError: true };
        }
      },
    );
  };
}

/** Arguments that fail the tool's schema are the agent's mistake: `bad_request` with what is wrong, as in the API (§5.2). */
function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new DomainError("bad_request", z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * What the agent reads for a failed tool: an error a module raised on purpose with its code and message, as in the API
 * (§5.2), others without details. Those others are Trackwall's errors and go into the error journal (ADR-94).
 */
function toolErrorText(facade: Facade, tool: string, err: unknown): string {
  if (err instanceof DomainError) return `${err.code}: ${err.message}`;
  facade.errorJournal.recordDaemonError(`mcp:${tool}`, err);
  return "internal: daemon error";
}

type ToolRuns = { [K in keyof typeof mcpTools]: (typeof mcpTools)[K] extends McpTool<infer A, infer R> ? ToolRun<A, R> : never };

/** One run for every tool in `mcpTools`: a missing one is a compile error. */
const runs: ToolRuns = {
  listRepos: async (facade, { tags: wanted = [] }) => {
    // Without a filter the repo list does not depend on tags: a bad `repoTags` in workspace.yaml leaves repos without tags,
    // not without a list.
    const tags = facade.cards.tags().catch((err: unknown) => {
      if (wanted.length > 0) throw err;
      return [];
    });
    const [list, tagList] = await Promise.all([facade.workspace.list(), tags]);
    const run = facade.workspace.syncRun();
    const repos = list.repos.map((repo) => agentRepo(repo, run, tagNames(tagList.find((t) => t.repo === repo.id))));
    return { projectsDir: list.projectsDir, repos: repos.filter((repo) => hasEveryTag(repo.tags, wanted)) };
  },
  getRepo: async (facade, { repo: id }) => {
    const [repo, overview, miseTasks, tags] = await Promise.all([
      facade.workspace.repo(id),
      facade.workspace.overview(id),
      facade.mise.tasks(id),
      // A card that cannot be computed does not take away the README and mise tasks: such a repo only has empty tags here, and
      // `get_repo_card` gives the reason.
      facade.cards.card(id).then(
        (result) => result.tags.map((t) => t.name),
        () => [],
      ),
    ]);
    return {
      repo: agentRepo(repo, facade.workspace.syncRun(), tags),
      readme: overview.readme && {
        ...overview.readme,
        text: overview.readme.text.slice(0, README_MAX_CHARS),
        truncated: overview.readme.truncated || overview.readme.text.length > README_MAX_CHARS,
      },
      commits: overview.commits.slice(0, RECENT_COMMITS),
      miseTasks,
    };
  },
  getRepoCard: (facade, { repo }) => facade.cards.card(repo),
  tail: async (facade, { repo, task, miseTask, sinceSeq, limit }) => {
    // The repo must exist (`not_found` as in get_repo); the log of a mise task that printed nothing is empty.
    await facade.workspace.repo(repo);
    const target = miseTarget(facade, repo, task);
    return facade.logs.tail({ source: miseTaskLogSource(target.repo, target.task, miseTask), sinceSeq, limit });
  },
  getErrors: async (facade, { repo, task, ...query }) => {
    // The repo and the task must exist (`not_found` as in tail): a typo in an id must not look like "no errors". A
    // mise task without output has no log yet, so an unknown mise task name gives no errors, as an empty log in tail.
    if (repo !== undefined) await facade.workspace.repo(repo);
    if (task !== undefined) facade.agents.taskOfRepo(task, repo);
    return facade.logs.errors({ repo, task, ...query });
  },
  getTestResults: (facade, { repo, task, since }) => facade.testReports.results(miseTarget(facade, repo, task), since),
  whoCalls: (facade, { repo }) => facade.graph.whoCalls(repo),
  subgraphFor: (facade, { repo, depth }) => facade.graph.subgraph(repo, depth),
  findEndpoint: (facade, { query, method }) => facade.graph.findEndpoint(query, method),
  searchCode: async (facade, { repos, tags = [], ...query }) => {
    if (tags.length === 0) return facade.workspace.searchCode(query, repos);
    // Cards cover every repo of the projects folder, so an id unknown to them stays: the workspace reports it as
    // `not_found` instead of it silently dropping out.
    const cards = await facade.cards.tags();
    const tagged = cards.filter((entry) => hasEveryTag(tagNames(entry), tags)).map((entry) => entry.repo);
    const isUnknown = (id: string) => !cards.some((entry) => entry.repo === id);
    return facade.workspace.searchCode(query, repos ? repos.filter((id) => tagged.includes(id) || isUnknown(id)) : tagged);
  },
  listSessions: async (facade, { repo }, { caller }) => {
    // The repo must exist (`not_found` as in get_repo): a typo in the id must not look like "no sessions".
    if (repo !== undefined) await facade.workspace.repo(repo);
    const { sessions, tasks, proposals } = facade.agents.sessions();
    const inRepo = (item: { repo: string | null }) => repo === undefined || item.repo === repo;
    return {
      sessions: sessions.filter(inRepo).map(agentSession),
      tasks: tasks.filter(inRepo),
      proposals: proposals.filter(inRepo),
      caller,
    };
  },
  getSession: async (facade, { session: id }) => {
    const session = agentSession(facade.agents.session(id));
    if (session.task === null) return { session, task: null, changes: null, changesError: null, verification: null, javaNavigation: null };
    const task = facade.agents.task(session.task);
    const verification = facade.verifications.get(task.id);
    // The session and the task exist even when the changes cannot be computed (worktree deleted by hand, ending in progress).
    const [javaNavigation, summary] = await Promise.all([
      facade.agents.taskJavaNavigation(task.id),
      facade.agents.taskChangesSummary(task.id).then(
        (changes) => ({ changes, changesError: null }),
        (err: unknown) => {
          if (!(err instanceof DomainError)) throw err;
          return { changes: null, changesError: `${err.code}: ${err.message}` };
        },
      ),
    ]);
    return { session, task, ...summary, verification, javaNavigation };
  },
  getDayReport: async (facade) => ({ report: facade.dayStart.report() }),
  getTaskChanges: (facade, { task, paths, maxPatchBytes }) => facade.agents.agentTaskChanges(task, maxPatchBytes, paths),
  proposeTask: async (facade, { model, approvals, item, ...proposal }, { caller }) => {
    // Without a model the task runs on Copilot CLI's default (ADR-98); without a mode its agent asks (ADR-105).
    return {
      proposal: await facade.agents.propose(caller, {
        ...proposal,
        model: model ?? null,
        approvals: approvals ?? "ask",
        item: item ?? null,
      }),
    };
  },
  proposeFolderAction: async (facade, { repo, reason }, { caller }) => ({
    proposal: await facade.agents.proposeRepoRemoval(caller, repo, reason),
  }),
  listItems: async (facade, filter) => {
    const { items } = await facade.board.board();
    const { tasks } = facade.agents.sessions();
    return { items: itemSummaries(items.filter((item) => matchesItem(item, filter)).sort(compareSiblings), items, tasks) };
  },
  getItem: async (facade, { item: id }) => {
    const [item, { items }] = await Promise.all([facade.board.item(id), facade.board.board()]);
    const { tasks } = facade.agents.sessions();
    return {
      item,
      path: ancestorsOf(items, item).map(({ id, kind, title }) => ({ id, kind, title })),
      children: itemSummaries(childrenOf(items, id), items, tasks),
      tasks: tasks.filter((task) => task.item === id),
    };
  },
  createItem: async (facade, { title, body, parent, repos, link }, { caller }) => {
    const { task, item: own } = await facade.agents.findingsPlace(caller);
    const item = await facade.board.create(
      { kind: "item", title, body, parent: parent ?? own, repos: repos ?? [], link: link ?? null, column: "ideas" },
      { kind: "agent", task },
    );
    return { item };
  },
  updateItem: async (facade, { item, ...change }) => ({ item: await facade.board.updateByAgent(item, change) }),
  reportResult: async (facade, { summary }, { caller }) => ({ task: facade.agents.reportSummary(caller, summary) }),
  getReviewComments: async (facade, _args, { caller }) => ({ comments: facade.agents.takeReviewComments(caller) }),
  sendMessage: async (facade, { task, text }, { caller }) => facade.agents.sendMessage(caller, task, text),
  resumeTask: async (facade, { task }, { caller }) => {
    const resumed = await facade.agents.resumeTaskFor(caller, task);
    return { task: resumed.task, session: agentSession(resumed.session) };
  },
  getMessages: async (facade, _args, { caller }) => ({
    messages: facade.agents.takeMessages(caller).map(({ readAt: _, ...message }) => message),
  }),
  getUpdates: async (facade, _args, { caller }) => facade.agents.takeUpdates(caller),
  waitForSession: async (facade, { session, task, timeoutSeconds }, { caller, signal }) => {
    // The tool's schema lets through exactly one of them; the second check gives the type without a cast.
    const target = session !== undefined ? { session } : task !== undefined ? { task } : undefined;
    if (!target) throw new DomainError("bad_request", "pass exactly one of session and task");
    const outcome = await facade.agents.waitFor(caller, target, timeoutSeconds * 1000, signal);
    return { ...outcome, session: outcome.session && agentSession(outcome.session) };
  },
  runMiseTask: async (facade, { repo, task, miseTask }, { caller }) => {
    const target = callerTarget(facade, caller, repo, task, MISE_TASK_ACTION);
    return { run: await facade.agents.runNeedingMiseTrust(caller, target, () => facade.mise.start(target, miseTask)) };
  },
  stopMiseTask: async (facade, { repo, task, miseTask }, { caller }) => ({
    run: await facade.mise.stop(callerTarget(facade, caller, repo, task, MISE_TASK_ACTION), miseTask),
  }),
  waitForMiseTask: async (facade, { repo, task, miseTask, timeoutSeconds }, { signal }) => ({
    run: await facade.mise.waitForEnd(miseTarget(facade, repo, task), miseTask, timeoutSeconds * 1000, signal),
  }),
  listRunningMiseTasks: async (facade) => ({ miseTasks: facade.mise.running() }),
  verifyTask: async (facade, { repo, task, runId, timeoutSeconds }, { caller, signal }) => {
    assertCallerMayVerify(facade, caller, task);
    const target = callerTarget(facade, caller, repo, task, VERIFY_ACTION);
    const verify = () => facade.verifications.verify(task, runId, timeoutSeconds * 1000, signal);
    return { verification: await facade.agents.runNeedingMiseTrust(caller, target, verify) };
  },
  startService: async (facade, { repo, task, lease, dependencies, timeoutSeconds }, { caller }) => {
    // Only the root comes from the session; its dependencies come from the graph, so they may be other repos.
    const target = callerTarget(facade, caller, repo, task, SERVICE_ACTION);
    const start = () => facade.services.start({ ...target, lease, dependencies, waitMs: timeoutSeconds * 1000 });
    return { slice: await facade.agents.runNeedingMiseTrust(caller, target, start) };
  },
  stopService: async (facade, { repo, task, dependencies }, { caller }) => {
    const target = callerTarget(facade, caller, repo, task, SERVICE_ACTION);
    return { services: await facade.services.stop({ ...target, dependencies }) };
  },
  listServices: async (facade) => ({ services: await facade.services.list() }),
  callEndpoint: (facade, { repo, task, timeoutSeconds, ...request }) =>
    facade.services.call({ ...miseTarget(facade, repo, task), ...request, timeoutMs: timeoutSeconds * 1000 }),
};

/**
 * Registrations in the order of `mcpTools`, in which the UI lists the names. TypeScript will not tie `mcpTools[k]` to `runs[k]`
 * in a loop over the keys, so the list is explicit, and the `tools/list` test checks that it is complete and in `mcpTools` order.
 */
export const TOOL_REGISTRATIONS: readonly ToolRegistration[] = [
  defineTool(mcpTools.listRepos, runs.listRepos),
  defineTool(mcpTools.getRepo, runs.getRepo),
  defineTool(mcpTools.getRepoCard, runs.getRepoCard),
  defineTool(mcpTools.tail, runs.tail),
  defineTool(mcpTools.getErrors, runs.getErrors),
  defineTool(mcpTools.getTestResults, runs.getTestResults),
  defineTool(mcpTools.whoCalls, runs.whoCalls),
  defineTool(mcpTools.subgraphFor, runs.subgraphFor),
  defineTool(mcpTools.findEndpoint, runs.findEndpoint),
  defineTool(mcpTools.searchCode, runs.searchCode),
  defineTool(mcpTools.listSessions, runs.listSessions),
  defineTool(mcpTools.getSession, runs.getSession),
  defineTool(mcpTools.getDayReport, runs.getDayReport),
  defineTool(mcpTools.getTaskChanges, runs.getTaskChanges),
  defineTool(mcpTools.proposeTask, runs.proposeTask),
  defineTool(mcpTools.proposeFolderAction, runs.proposeFolderAction),
  defineTool(mcpTools.listItems, runs.listItems),
  defineTool(mcpTools.getItem, runs.getItem),
  defineTool(mcpTools.createItem, runs.createItem),
  defineTool(mcpTools.updateItem, runs.updateItem),
  defineTool(mcpTools.reportResult, runs.reportResult),
  defineTool(mcpTools.getReviewComments, runs.getReviewComments),
  defineTool(mcpTools.sendMessage, runs.sendMessage),
  defineTool(mcpTools.resumeTask, runs.resumeTask),
  defineTool(mcpTools.getMessages, runs.getMessages),
  defineTool(mcpTools.getUpdates, runs.getUpdates),
  defineTool(mcpTools.waitForSession, runs.waitForSession),
  defineTool(mcpTools.runMiseTask, runs.runMiseTask),
  defineTool(mcpTools.stopMiseTask, runs.stopMiseTask),
  defineTool(mcpTools.waitForMiseTask, runs.waitForMiseTask),
  defineTool(mcpTools.listRunningMiseTasks, runs.listRunningMiseTasks),
  defineTool(mcpTools.verifyTask, runs.verifyTask),
  defineTool(mcpTools.startService, runs.startService),
  defineTool(mcpTools.stopService, runs.stopService),
  defineTool(mcpTools.listServices, runs.listServices),
  defineTool(mcpTools.callEndpoint, runs.callEndpoint),
];

/** The arguments a destructive tool logs: only the ones its contract names (the rest may be free text with secrets). */
function auditView(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, args[k]]));
}

/** Tag filter of `list_repos` and `search_code`: the repo has every wanted tag. */
function hasEveryTag(tags: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((tag) => tags.includes(tag));
}

/**
 * A Trackwall session starts and stops processes only in the repo it works in (§8, ADR-41), so a task session does
 * not reach other repos in the projects folder through its own bridge. The supervisor works in no repo (ADR-58): it
 * hands running things to the session of the repo with a task proposal. An agent outside Trackwall (`caller: null`)
 * is the user's program, like a terminal, and reaches every repo. A guard for the agent, not a security boundary: a
 * session process can call `/mcp` without its session token (§8).
 */
function assertCallerRepo(facade: Facade, caller: string | null, repo: string, action: string): void {
  if (caller === null) return;
  const session = facade.agents.session(caller);
  const own = session.repo;
  if (own === null)
    throw new DomainError(
      "bad_request",
      `${inNoRepo(session)} works in no repo and runs nothing in one; propose a task in ${repo} instead`,
    );
  if (own !== repo) throw new DomainError("bad_request", `a session in ${own} can ${action} of ${own}, not of ${repo}`);
}

/**
 * Where a session may run and stop a mise task or a service (ADR-41, ADR-59, ADR-61): its own repo, and for a task
 * session the repo root or its own task's worktree, so it does not run another agent's worktree. An agent outside
 * Trackwall reaches every repo and task. A guard for the agent, not a security boundary, as in `assertCallerRepo`.
 */
function callerTarget(facade: Facade, caller: string | null, repo: string, task: string | undefined, action: string): MiseTarget {
  assertCallerRepo(facade, caller, repo, action);
  const own = caller === null ? null : facade.agents.session(caller).task;
  if (task !== undefined && own !== null && task !== own)
    throw new DomainError("bad_request", `a session of task ${own} can ${action} of its own worktree, not of that of task ${task}`);
  return miseTarget(facade, repo, task);
}

/**
 * Who may verify a task (ADR-64), before the repo gate of `callerTarget`, with messages that fit verifying: the
 * supervisor reads the verdict instead of running tests, and a task session verifies its own task only.
 */
function assertCallerMayVerify(facade: Facade, caller: string | null, task: string): void {
  if (caller === null) return;
  const session = facade.agents.session(caller);
  if (session.repo === null)
    throw new DomainError(
      "bad_request",
      `${inNoRepo(session)} runs no tests; read task ${task}'s verification with ${mcpTools.getSession.name}, or ask its session to verify it`,
    );
  if (session.task !== null && session.task !== task)
    throw new DomainError("bad_request", `a task session can verify only its own task ${session.task}, not task ${task}`);
}

/** A session in the projects folder as a refusal names it: the supervisor (ADR-58) or a free session (ADR-100). */
function inNoRepo(session: Session): string {
  return isSupervisor(session) ? "the supervisor" : "a free session";
}

/** The repo root, or the worktree of a task of that repo (`bad_request` for a task of another repo, ADR-59). */
function miseTarget(facade: Facade, repo: string, task: string | undefined): MiseTarget {
  if (task === undefined) return { repo, task: null };
  facade.agents.taskOfRepo(task, repo);
  return { repo, task };
}

/**
 * A session without the last screen lines of an ended group and without its agent dialog, which is read from the screen:
 * one session's screen does not reach another (§8, ADR-36, ADR-66).
 */
function agentSession({ run, dialog: _dialog, ...session }: Session): AgentSession {
  if (run.kind !== "exited") return { ...session, run };
  const { lastLines: _, ...exited } = run;
  return { ...session, run: exited };
}

/** A repo joins its sync result by path, because the id can change together with the directory name (ADR-18). */
function agentRepo(repo: Repo, run: SyncRun | null, tags: string[]): AgentRepo {
  const result = run?.repos.find((r) => r.path === repo.path);
  return { ...repo, lastSync: run && result ? { startedAt: run.startedAt, finishedAt: run.finishedAt, result } : null, tags };
}

/** The repo's tag names; a repo git cannot read has no tags (its state on the list says it is unavailable anyway). */
function tagNames(entry: RepoTags | undefined): string[] {
  return entry?.kind === "ok" ? entry.tags.map((t) => t.name) : [];
}

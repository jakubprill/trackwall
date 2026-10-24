import type { McpServer } from "@modelcontextprotocol/server";
import {
  type AgentRepo,
  type AgentSession,
  type McpTool,
  mcpTools,
  type Repo,
  type RepoTags,
  type Session,
  type SyncRun,
} from "@trackwall/protocol";
import type { z } from "zod";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";

/**
 * Narzędzia MCP daemona (§5.3, ADR-24): każde to cienkie mapowanie na fasadę, więc agent widzi ten sam stan co UI
 * (§1.1). Żadne nie zmienia konfiguracji ani repo (§8) i żadne nie uruchamia sesji, nie odpowiada w niej ani jej nie
 * zatrzymuje. Zapisują tylko `propose_task` (propozycja, którą zadaniem robi dopiero użytkownik w UI) i `report_result`
 * (podsumowanie własnego zadania sesji), ADR-39; procesy uruchamiają i zatrzymują tylko `run_mise_task`
 * i `stop_mise_task`: task mise z aktualnej listy zaufanej konfiguracji repo, jak przycisk w UI (ADR-41).
 */

/**
 * README dłuższe niż to i tak nie mieści się sensownie w kontekście agenta (wynik niesie je dwa razy: w tekście
 * i w `structuredContent`); limit podglądu w UI (512 KB) jest dla człowieka, który przewija.
 */
const README_MAX_CHARS = 32_000;
/** Ile ostatnich commitów zwraca `get_repo`: tyle wystarcza, żeby agent wiedział, co się ostatnio działo. */
const RECENT_COMMITS = 10;

export interface ToolContext {
  facade: Facade;
  /** Linia logu daemona o wywołaniu (narzędzie, czas, wynik), bez argumentów; tabela `audit` przyjdzie z SQLite. */
  log: (msg: string) => void;
}

/** Jedno wywołanie: sesja, która woła (po tokenie sesji, ADR-39; `null` dla agenta spoza Trackwall), i przerwanie przez klienta. */
interface ToolCall {
  caller: string | null;
  signal: AbortSignal;
  /** A daemon log line about this call (with the calling session), e.g. the arguments of an action that starts a process. */
  log: (msg: string) => void;
}

/** Wykonanie narzędzia na fasadzie: argumenty i wynik mają typy schematów z jego kontraktu. */
type ToolRun<Args extends z.ZodObject, Result extends z.ZodObject> = (
  facade: Facade,
  args: z.output<Args>,
  call: ToolCall,
) => Promise<z.input<Result>>;

/** Rejestruje jedno narzędzie w serwerze MCP utworzonym dla jednego żądania jednej sesji (`caller`). */
type ToolRegistration = (server: McpServer, ctx: ToolContext & { caller: string | null }) => void;

/**
 * Narzędzie z kontraktu (`mcpTools` w protocol) i jego wykonanie na fasadzie; wynik musi zgadzać się z kontraktem
 * co do typu, jak trasy API w `api/routes.ts`.
 */
function defineTool<Args extends z.ZodObject, Result extends z.ZodObject>(
  tool: McpTool<Args, Result>,
  run: ToolRun<Args, Result>,
): ToolRegistration {
  // SDK typuje argumenty z typu schematu, a z parametru generycznego nie umie; argumenty przechodzą więc przez
  // schemat narzędzia jeszcze raz (SDK sprawdza je już przed wywołaniem), co daje ich dokładny typ bez rzutowania.
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
        // Wołająca sesja w logu, bo propozycja i podsumowanie zapisują coś w jej imieniu; tabela `audit` przyjdzie z SQLite.
        const label = ctx.caller === null ? tool.name : `${tool.name} (session ${ctx.caller})`;
        try {
          const call = { caller: ctx.caller, signal: extra.mcpReq.signal, log: (msg: string) => ctx.log(`${label}: ${msg}`) };
          const result = tool.result.parse(await run(ctx.facade, tool.args.parse(args), call));
          ctx.log(`${label}: ok in ${Date.now() - started} ms`);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          ctx.log(`${label}: error in ${Date.now() - started} ms: ${String(err)}`);
          // Błąd zgłoszony świadomie przez moduł idzie do agenta z kodem i treścią, jak w API (§5.2); inny bez szczegółów.
          const text = err instanceof DomainError ? `${err.code}: ${err.message}` : "internal: daemon error";
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  };
}

type ToolRuns = { [K in keyof typeof mcpTools]: (typeof mcpTools)[K] extends McpTool<infer A, infer R> ? ToolRun<A, R> : never };

/** Po jednym wykonaniu na każde narzędzie z `mcpTools`: brak któregoś to błąd kompilacji. */
const runs: ToolRuns = {
  listRepos: async (facade, { tags: wanted = [] }) => {
    // Bez filtra lista repo nie zależy od tagów: zły `repoTags` w workspace.yaml zostawia repo bez tagów, nie bez listy.
    const tags = facade.cards.tags().catch((err: unknown) => {
      if (wanted.length > 0) throw err;
      return [];
    });
    const [list, tagList] = await Promise.all([facade.workspace.list(), tags]);
    const run = facade.workspace.syncRun();
    const repos = list.repos.map((repo) => agentRepo(repo, run, tagNames(tagList.find((t) => t.repo === repo.id))));
    return { projectsDir: list.projectsDir, repos: repos.filter((repo) => wanted.every((tag) => repo.tags.includes(tag))) };
  },
  getRepo: async (facade, { repo: id }) => {
    const [repo, overview, miseTasks, tags] = await Promise.all([
      facade.workspace.repo(id),
      facade.workspace.overview(id),
      facade.mise.tasks(id),
      // Karta nie zabiera README i tasków: repo, którego karty nie da się policzyć, ma tu tylko puste tagi, a powód
      // podaje `get_repo_card`.
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
  tail: async (facade, { repo, miseTask, sinceSeq, limit }) => {
    // Repo musi istnieć (`not_found` jak w get_repo); log taska, który nic nie wypisał, jest pusty.
    await facade.workspace.repo(repo);
    return facade.logs.tail({ source: { kind: "mise-task", repo, miseTask }, sinceSeq, limit });
  },
  getErrors: async (facade, { repo, ...query }) => {
    // The repo must exist (`not_found` as in tail): a typo in the id must not look like "no errors".
    if (repo !== undefined) await facade.workspace.repo(repo);
    return facade.logs.errors({ repo, ...query });
  },
  whoCalls: (facade, { repo }) => facade.graph.whoCalls(repo),
  subgraphFor: (facade, { repo, depth }) => facade.graph.subgraph(repo, depth),
  findEndpoint: (facade, { query, method }) => facade.graph.findEndpoint(query, method),
  listSessions: async (facade, { repo }, { caller }) => {
    // Repo musi istnieć (`not_found` jak w get_repo): literówka w identyfikatorze nie może wyglądać jak „brak sesji”.
    if (repo !== undefined) await facade.workspace.repo(repo);
    const { sessions, tasks, proposals } = facade.agents.sessions();
    const inRepo = (item: { repo: string }) => repo === undefined || item.repo === repo;
    return {
      sessions: sessions.filter(inRepo).map(agentSession),
      tasks: tasks.filter(inRepo),
      proposals: proposals.filter(inRepo),
      caller,
    };
  },
  getSession: async (facade, { session: id }) => {
    const session = agentSession(facade.agents.session(id));
    if (session.task === null) return { session, task: null, changes: null, changesError: null };
    const task = facade.agents.task(session.task);
    // Sesja i zadanie istnieją, nawet gdy zmian nie da się policzyć (worktree usunięty ręcznie, trwa zakończenie).
    return facade.agents.taskChangesSummary(task.id).then(
      (changes) => ({ session, task, changes, changesError: null }),
      (err: unknown) => {
        if (!(err instanceof DomainError)) throw err;
        return { session, task, changes: null, changesError: `${err.code}: ${err.message}` };
      },
    );
  },
  proposeTask: async (facade, proposal, { caller }) => ({ proposal: await facade.agents.propose(caller, proposal) }),
  reportResult: async (facade, { summary }, { caller }) => ({ task: facade.agents.reportSummary(caller, summary) }),
  waitForSession: async (facade, { session, task, timeoutSeconds }, { caller, signal }) => {
    // Schemat narzędzia przepuszcza dokładnie jedno z nich; drugie sprawdzenie daje typ bez rzutowania.
    const target = session !== undefined ? { session } : task !== undefined ? { task } : undefined;
    if (!target) throw new DomainError("bad_request", "pass exactly one of session and task");
    const outcome = await facade.agents.waitFor(caller, target, timeoutSeconds * 1000, signal);
    return { ...outcome, session: outcome.session && agentSession(outcome.session) };
  },
  runMiseTask: async (facade, { repo, miseTask }, call) => {
    callerRepo(facade, call.caller, repo);
    call.log(`run mise task "${miseTask}" in ${repo}`);
    return { run: await facade.mise.start(repo, miseTask) };
  },
  stopMiseTask: async (facade, { repo, miseTask }, call) => {
    callerRepo(facade, call.caller, repo);
    call.log(`stop mise task "${miseTask}" in ${repo}`);
    return { run: await facade.mise.stop(repo, miseTask) };
  },
  waitForMiseTask: async (facade, { repo, miseTask, timeoutSeconds }, { signal }) => ({
    run: await facade.mise.waitForEnd(repo, miseTask, timeoutSeconds * 1000, signal),
  }),
  listRunningMiseTasks: async (facade) => ({ miseTasks: facade.mise.running() }),
};

/**
 * Rejestracje w kolejności `mcpTools`, w której UI wypisuje nazwy. TypeScript nie powiąże `mcpTools[k]` z `runs[k]`
 * w pętli po kluczach, więc lista jest jawna, a jej komplet i kolejność względem `mcpTools` sprawdza test `tools/list`.
 */
export const TOOL_REGISTRATIONS: readonly ToolRegistration[] = [
  defineTool(mcpTools.listRepos, runs.listRepos),
  defineTool(mcpTools.getRepo, runs.getRepo),
  defineTool(mcpTools.getRepoCard, runs.getRepoCard),
  defineTool(mcpTools.tail, runs.tail),
  defineTool(mcpTools.getErrors, runs.getErrors),
  defineTool(mcpTools.whoCalls, runs.whoCalls),
  defineTool(mcpTools.subgraphFor, runs.subgraphFor),
  defineTool(mcpTools.findEndpoint, runs.findEndpoint),
  defineTool(mcpTools.listSessions, runs.listSessions),
  defineTool(mcpTools.getSession, runs.getSession),
  defineTool(mcpTools.proposeTask, runs.proposeTask),
  defineTool(mcpTools.reportResult, runs.reportResult),
  defineTool(mcpTools.waitForSession, runs.waitForSession),
  defineTool(mcpTools.runMiseTask, runs.runMiseTask),
  defineTool(mcpTools.stopMiseTask, runs.stopMiseTask),
  defineTool(mcpTools.waitForMiseTask, runs.waitForMiseTask),
  defineTool(mcpTools.listRunningMiseTasks, runs.listRunningMiseTasks),
];

/**
 * A Trackwall session starts and stops processes only in the repo it works in (§8, ADR-41), so a task session does
 * not reach other repos in the projects folder. An agent outside Trackwall (`caller: null`) is the user's program,
 * like a terminal, and reaches every repo.
 */
function callerRepo(facade: Facade, caller: string | null, repo: string): void {
  if (caller === null) return;
  const own = facade.agents.session(caller).repo;
  if (own !== repo) throw new DomainError("bad_request", `a session in ${own} can run and stop only mise tasks of ${own}, not of ${repo}`);
}

/** Sesja bez ostatnich linii ekranu zakończonej grupy: ekran jednej sesji nie trafia do innej (§8, ADR-36). */
function agentSession({ run, ...session }: Session): AgentSession {
  if (run.kind !== "exited") return { ...session, run };
  const { lastLines: _, ...exited } = run;
  return { ...session, run: exited };
}

/** Repo łączy się z wynikiem synchronizacji po ścieżce, bo identyfikator może się zmienić razem z nazwą katalogu (ADR-18). */
function agentRepo(repo: Repo, run: SyncRun | null, tags: string[]): AgentRepo {
  const result = run?.repos.find((r) => r.path === repo.path);
  return { ...repo, lastSync: run && result ? { startedAt: run.startedAt, finishedAt: run.finishedAt, result } : null, tags };
}

/** Nazwy tagów repo; repo, którego git nie czyta, nie ma tagów (jego stan na liście i tak mówi, że jest niedostępne). */
function tagNames(entry: RepoTags | undefined): string[] {
  return entry?.kind === "ok" ? entry.tags.map((t) => t.name) : [];
}

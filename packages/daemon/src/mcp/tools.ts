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
 * (§1.1). Wszystkie tylko czytają; żadne nie zmienia konfiguracji, repo ani procesów (§8), więc sesji nie uruchamia,
 * nie odpowiada w niej i jej nie zatrzymuje.
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

/** Wykonanie narzędzia na fasadzie: argumenty i wynik mają typy schematów z jego kontraktu. */
type ToolRun<Args extends z.ZodObject, Result extends z.ZodObject> = (facade: Facade, args: z.output<Args>) => Promise<z.input<Result>>;

/** Rejestruje jedno narzędzie w serwerze MCP utworzonym dla jednego żądania. */
type ToolRegistration = (server: McpServer, ctx: ToolContext) => void;

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
      { description: tool.description, inputSchema, outputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args) => {
        const started = Date.now();
        try {
          const result = tool.result.parse(await run(ctx.facade, tool.args.parse(args)));
          ctx.log(`${tool.name}: ok in ${Date.now() - started} ms`);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          ctx.log(`${tool.name}: error in ${Date.now() - started} ms: ${String(err)}`);
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
  listSessions: async (facade, { repo }) => {
    // Repo musi istnieć (`not_found` jak w get_repo): literówka w identyfikatorze nie może wyglądać jak „brak sesji”.
    if (repo !== undefined) await facade.workspace.repo(repo);
    const { sessions, tasks } = facade.agents.sessions();
    const inRepo = (item: { repo: string }) => repo === undefined || item.repo === repo;
    return { sessions: sessions.filter(inRepo).map(agentSession), tasks: tasks.filter(inRepo) };
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
];

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

import type { McpServer } from "@modelcontextprotocol/server";
import { type McpTool, mcpTools, type Repo, type RepoWithLastSync, type SyncRun } from "@trackwall/protocol";
import type { z } from "zod";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";

/**
 * Narzędzia MCP daemona (§5.3, ADR-23): każde to cienkie mapowanie na fasadę, więc agent widzi ten sam stan co UI
 * (§1.1). Wszystkie tylko czytają; żadne nie zmienia konfiguracji, repo ani procesów (§8). Karty i graf dojdą tu jako
 * kolejne wpisy `mcpTools` w protocol i `runs` tutaj, razem z modułami `cards` i `graph`.
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
          ctx.log(`${tool.name}: ok w ${Date.now() - started} ms`);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          ctx.log(`${tool.name}: błąd w ${Date.now() - started} ms: ${String(err)}`);
          // Błąd zgłoszony świadomie przez moduł idzie do agenta z kodem i treścią, jak w API (§5.2); inny bez szczegółów.
          const text = err instanceof DomainError ? `${err.code}: ${err.message}` : "internal: wewnętrzny błąd daemona";
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  };
}

type ToolRuns = { [K in keyof typeof mcpTools]: (typeof mcpTools)[K] extends McpTool<infer A, infer R> ? ToolRun<A, R> : never };

/** Po jednym wykonaniu na każde narzędzie z `mcpTools`: brak któregoś to błąd kompilacji. */
const runs: ToolRuns = {
  listRepos: async (facade) => {
    const list = await facade.workspace.list();
    const run = facade.workspace.syncRun();
    return { projectsDir: list.projectsDir, repos: list.repos.map((repo) => withLastSync(repo, run)) };
  },
  getRepo: async (facade, { repo: id }) => {
    const [repo, overview, miseTasks] = await Promise.all([
      facade.workspace.repo(id),
      facade.workspace.overview(id),
      facade.mise.tasks(id),
    ]);
    return {
      repo: withLastSync(repo, facade.workspace.syncRun()),
      readme: overview.readme && {
        ...overview.readme,
        text: overview.readme.text.slice(0, README_MAX_CHARS),
        truncated: overview.readme.truncated || overview.readme.text.length > README_MAX_CHARS,
      },
      commits: overview.commits.slice(0, RECENT_COMMITS),
      miseTasks,
    };
  },
};

/**
 * Rejestracje w kolejności `mcpTools`, w której UI wypisuje nazwy. TypeScript nie powiąże `mcpTools[k]` z `runs[k]`
 * w pętli po kluczach, więc lista jest jawna, a jej komplet i kolejność względem `mcpTools` sprawdza test `tools/list`.
 */
export const TOOL_REGISTRATIONS: readonly ToolRegistration[] = [
  defineTool(mcpTools.listRepos, runs.listRepos),
  defineTool(mcpTools.getRepo, runs.getRepo),
];

/** Repo łączy się z wynikiem synchronizacji po ścieżce, bo identyfikator może się zmienić razem z nazwą katalogu (ADR-18). */
function withLastSync(repo: Repo, run: SyncRun | null): RepoWithLastSync {
  const result = run?.repos.find((r) => r.path === repo.path);
  return { ...repo, lastSync: run && result ? { startedAt: run.startedAt, finishedAt: run.finishedAt, result } : null };
}

import type { McpServer } from "@modelcontextprotocol/server";
import { GetRepoArgs, GetRepoResult, ListReposResult, type Repo, type RepoWithLastSync, type SyncRun } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";

/**
 * Narzędzia MCP daemona (§5.3, ADR-22): każde to cienkie mapowanie na fasadę, więc agent widzi ten sam stan co UI
 * (§1.1). Wszystkie tylko czytają; żadne nie zmienia konfiguracji, repo ani procesów (§8). Karty i graf dojdą tu jako
 * kolejne wpisy `MCP_TOOLS`, razem z modułami `cards` i `graph`.
 */

/** README dłuższe niż to i tak nie mieści się sensownie w kontekście agenta; reszta jest w repo. */
const README_MAX_CHARS = 32_000;
/** Ile ostatnich commitów zwraca `get_repo`: tyle wystarcza, żeby agent wiedział, co się ostatnio działo. */
const RECENT_COMMITS = 10;

export interface ToolContext {
  facade: Facade;
  /** Linia logu daemona o wywołaniu (narzędzie, czas, wynik), bez argumentów; tabela `audit` przyjdzie z SQLite. */
  log: (msg: string) => void;
}

/** Rejestruje jedno narzędzie w serwerze MCP utworzonym dla jednego żądania. */
type ToolRegistration = (server: McpServer, ctx: ToolContext) => void;

interface ToolDefinition<Args extends z.ZodObject, Result extends z.ZodObject> {
  name: string;
  description: string;
  args: Args;
  result: Result;
  run: (facade: Facade, args: z.output<Args>) => Promise<z.input<Result>>;
}

function defineTool<Args extends z.ZodObject, Result extends z.ZodObject>(def: ToolDefinition<Args, Result>): ToolRegistration {
  // SDK typuje argumenty z typu schematu, a z parametru generycznego nie umie; argumenty przechodzą więc przez
  // schemat narzędzia jeszcze raz (SDK sprawdza je już przed wywołaniem), co daje ich dokładny typ bez rzutowania.
  const inputSchema: z.ZodObject = def.args;
  const outputSchema: z.ZodObject = def.result;
  return (server, ctx) => {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) => {
        const started = Date.now();
        try {
          const result = def.result.parse(await def.run(ctx.facade, def.args.parse(args)));
          ctx.log(`${def.name}: ok w ${Date.now() - started} ms`);
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          ctx.log(`${def.name}: błąd w ${Date.now() - started} ms: ${String(err)}`);
          // Błąd zgłoszony świadomie przez moduł idzie do agenta z kodem i treścią, jak w API (§5.2); inny bez szczegółów.
          const text = err instanceof DomainError ? `${err.code}: ${err.message}` : "internal: wewnętrzny błąd daemona";
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  };
}

const listRepos = defineTool({
  name: "list_repos",
  description:
    "Lista repo z folderu z projektami użytkownika: identyfikator, ścieżka, adres repo zdalnego (host/ścieżka), " +
    "gałąź, ostatni commit, liczba lokalnych zmian, ahead/behind i wynik ostatniej synchronizacji. Zacznij od tego " +
    "narzędzia; identyfikator (pole id) podawaj do pozostałych.",
  args: z.object({}).strict(),
  result: ListReposResult,
  run: async (facade) => {
    const list = await facade.workspace.list();
    const run = facade.workspace.syncRun();
    return { projectsDir: list.projectsDir, repos: list.repos.map((repo) => withLastSync(repo, run)) };
  },
});

const getRepo = defineTool({
  name: "get_repo",
  description:
    "Szczegóły jednego repo: to samo co w list_repos, README z ostatniego commita (przycięte), ostatnie commity " +
    "i taski mise (nazwa, opis, stan uruchomienia) albo powód, dla którego mise ich nie podał.",
  args: GetRepoArgs,
  result: GetRepoResult,
  run: async (facade, { repo: id }) => {
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
});

/** Narzędzia w kolejności `tools/list`. */
export const MCP_TOOLS: readonly ToolRegistration[] = [listRepos, getRepo];

/** Repo łączy się z wynikiem synchronizacji po ścieżce, bo identyfikator może się zmienić razem z nazwą katalogu (ADR-18). */
function withLastSync(repo: Repo, run: SyncRun | null): RepoWithLastSync {
  const result = run?.repos.find((r) => r.path === repo.path);
  return { ...repo, lastSync: run && result ? { startedAt: run.startedAt, finishedAt: run.finishedAt, result } : null };
}

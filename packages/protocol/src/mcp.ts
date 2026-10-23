import { z } from "zod";
import { MiseTasks } from "./mise.ts";
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

/** Repo z listy (`Repo`) i jego wynik w ostatniej synchronizacji od startu daemona; `null`, gdy go w niej nie było. */
export const RepoWithLastSync = Repo.extend({ lastSync: LastSync.nullable() });
export type RepoWithLastSync = z.infer<typeof RepoWithLastSync>;

export const ListReposResult = z.object({
  /** Pełna ścieżka folderu z projektami; `null`, dopóki użytkownik go nie ustawi, a wtedy lista jest pusta. */
  projectsDir: z.string().nullable(),
  repos: z.array(RepoWithLastSync),
});
export type ListReposResult = z.infer<typeof ListReposResult>;

export const GetRepoResult = z.object({
  repo: RepoWithLastSync,
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

export const mcpTools = {
  listRepos: {
    name: LIST_REPOS,
    description:
      "Lista repo z folderu z projektami użytkownika: identyfikator, ścieżka, adres repo zdalnego (host/ścieżka), " +
      "gałąź, ostatni commit, liczba lokalnych zmian, ahead/behind i wynik w ostatniej synchronizacji od startu " +
      "Trackwall (lastSync: null, gdy od startu jej nie było). Zacznij od tego narzędzia; identyfikator (pole id) " +
      "podawaj do pozostałych.",
    args: z.object({}).strict(),
    result: ListReposResult,
  },
  getRepo: {
    name: "get_repo",
    description:
      `Szczegóły jednego repo: to samo co w ${LIST_REPOS}, README z ostatniego commita (przycięte), ostatnie ` +
      "commity i taski mise (nazwa, opis, stan uruchomienia) albo powód, dla którego mise ich nie podał.",
    args: z.object({ repo: RepoId.describe(`identyfikator repo z ${LIST_REPOS} (pole id)`) }).strict(),
    result: GetRepoResult,
  },
} satisfies Record<string, McpTool>;

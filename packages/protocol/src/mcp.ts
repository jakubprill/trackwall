import { z } from "zod";
import { RepoCardResult, TagName } from "./cards.ts";
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

export const mcpTools = {
  listRepos: {
    name: LIST_REPOS,
    description:
      "Lista repo z folderu z projektami użytkownika: identyfikator, ścieżka, adres repo zdalnego (host/ścieżka), " +
      "gałąź, ostatni commit, liczba lokalnych zmian, ahead/behind i wynik w ostatniej synchronizacji od startu " +
      "Trackwall (lastSync: null, gdy od startu jej nie było) i tagi repo (np. java, frontend, bff, monorepo oraz " +
      "tagi z reguł użytkownika). Argument tags zawęża listę do repo z każdym z podanych tagów. Zacznij od tego " +
      "narzędzia; identyfikator (pole id) podawaj do pozostałych.",
    args: z
      .object({ tags: z.array(TagName).max(20).optional().describe('tylko repo z każdym z tych tagów, bez #, np. ["java", "bff"]') })
      .strict(),
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
  getRepoCard: {
    name: "get_repo_card",
    description:
      "Karta repo z plików buildu i konfiguracji w ostatnim commicie, każdy fakt z dowodem (plik i linia): paczki, " +
      "które repo udostępnia (współrzędne Maven grupa:artefakt, nazwy npm), paczki, których używa (z zakresem), " +
      "wymagane wersje narzędzi (mise, .nvmrc, wersja Javy), wykryte mechanizmy (Spring Boot, Feign, WebClient, " +
      "OpenAPI, Kafka, Eureka, Config Server, Kubernetes, Helm, Docker, frameworki frontendu) i tagi z powodami. " +
      "Paczka udostępniana przez jedno repo i używana przez inne to połączenie między nimi. card: null w repo bez commitów.",
    args: z.object({ repo: RepoId.describe(`identyfikator repo z ${LIST_REPOS} (pole id)`) }).strict(),
    result: RepoCardResult,
  },
} satisfies Record<string, McpTool>;

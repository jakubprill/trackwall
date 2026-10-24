import { z } from "zod";
import { RepoCardResult, TagName } from "./cards.ts";
import { FindEndpointResult, MAX_FOUND_ENDPOINTS, MAX_SUBGRAPH_DEPTH, Subgraph, WhoCallsResult } from "./graph.ts";
import { HttpMethod } from "./http.ts";
import { LOG_BUFFER_RECORDS, LOG_TAIL_MAX, LogTail } from "./logs.ts";
import { MiseTaskName, MiseTasks } from "./mise.ts";
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
const GET_REPO = "get_repo";
const RepoArg = RepoId.describe(`identyfikator repo z ${LIST_REPOS} (pole id)`);

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
    name: GET_REPO,
    description:
      `Szczegóły jednego repo: to samo co w ${LIST_REPOS} (z tagami; puste, gdy karty nie da się policzyć), README z ostatniego commita (przycięte), ostatnie ` +
      "commity i taski mise (nazwa, opis, stan uruchomienia) albo powód, dla którego mise ich nie podał.",
    args: z.object({ repo: RepoArg }).strict(),
    result: GetRepoResult,
  },
  getRepoCard: {
    name: "get_repo_card",
    description:
      "Karta repo z plików buildu, konfiguracji i kodu w ostatnim commicie, każdy fakt z dowodem (plik i linia). " +
      "provides: paczki (kind package: współrzędne Maven grupa:artefakt, nazwy npm), aplikacje Spring Boot (kind app: " +
      "spring.application.name, port) i endpointy HTTP z kontrolerów (kind endpoint: metoda, pełna ścieżka, handler). " +
      "consumes: paczki z zakresem i klienci HTTP (kind http: Feign, @HttpExchange, WebClient, RestClient, RestTemplate, " +
      "adresy z application*.yml w każdym profilu Spring, .env i proxy frontendu; z nazwą aplikacji albo adresem i " +
      "wywołaniami). Do tego wymagane wersje narzędzi, wykryte mechanizmy (Spring Boot, Feign, Kafka, Eureka, " +
      "Kubernetes…) i tagi z powodami. card: null w repo bez commitów.",
    args: z.object({ repo: RepoArg }).strict(),
    result: RepoCardResult,
  },
  tail: {
    name: "tail",
    description:
      "Log taska mise repo (wyjście stdout i stderr, od najstarszego): rekordy z numerem seq, uruchomieniem (runId), " +
      "strumieniem, poziomem z treści linii (error, warn, info…) i treścią bez kolorów, z sekretami zamienionymi na ***. " +
      "Bez sinceSeq zwraca ostatnie rekordy; potem podawaj nextSeq z poprzedniej odpowiedzi jako sinceSeq, żeby " +
      `dostać tylko nowe. dropped: true znaczy, że część rekordów przepadła (daemon trzyma ostatnie rekordy taska, najwyżej ${LOG_BUFFER_RECORDS}) ` +
      `albo kursor jest z poprzedniego działania Trackwall. Taski i ich stan podaje ${GET_REPO}.`,
    args: z
      .object({
        repo: RepoArg,
        miseTask: MiseTaskName.describe(`nazwa taska mise z ${GET_REPO} (pole miseTasks)`),
        sinceSeq: z.number().int().nonnegative().optional().describe("nextSeq z poprzedniej odpowiedzi"),
        limit: z.number().int().min(1).max(LOG_TAIL_MAX).describe(`ile rekordów najwyżej (do ${LOG_TAIL_MAX})`),
      })
      .strict(),
    result: LogTail,
  },
  whoCalls: {
    name: "who_calls",
    description:
      "Kto używa danego repo: krawędzie grafu połączeń skierowane do tego repo, każda z rodzajem (package: repo " +
      "używa paczki zbudowanej w tym repo; http: klient HTTP repo woła aplikację albo endpointy tego repo; manual: " +
      "połączenie wpisane przez użytkownika), kluczem (nazwa paczki, nazwa aplikacji albo adres, opis), pewnością " +
      "(exact, high, medium, low) i dowodami (repo, plik, linia; dla http także pary wywołanie–endpoint). Przed zmianą " +
      "API albo paczki repo sprawdź, kogo dotknie; kto woła konkretny endpoint, podaje find_endpoint.",
    args: z.object({ repo: RepoArg }).strict(),
    result: WhoCallsResult,
  },
  subgraphFor: {
    name: "subgraph_for",
    description:
      "Fragment grafu połączeń wokół repo: repo w odległości do depth krawędzi w obie strony (kogo używa i kto " +
      "używa jego) i krawędzie między nimi (paczki, HTTP, ręczne), z dowodami. Węzeł ma tagi, nazwy aplikacji Spring " +
      "Boot, liczbę endpointów i problem, gdy karty repo nie da się policzyć.",
    args: z
      .object({
        repo: RepoArg,
        depth: z.number().int().min(1).max(MAX_SUBGRAPH_DEPTH).default(1).describe("ile krawędzi od repo, domyślnie 1"),
      })
      .strict(),
    result: Subgraph,
  },
  findEndpoint: {
    name: "find_endpoint",
    description:
      "Endpointy HTTP z kontrolerów Spring we wszystkich repo pasujące do zapytania: ścieżka od / (także konkretna, " +
      "/api/orders/42 znajdzie /api/orders/{id}) albo fragment ścieżki, nazwy handlera (Klasa.metoda) lub nazwy " +
      "aplikacji. Każdy z repo, metodą, pełną ścieżką, plikiem i linią oraz callers: repo, których klienci HTTP go " +
      `wołają, z pewnością i dowodem. Najwyżej ${MAX_FOUND_ENDPOINTS} wyników (truncated: true, gdy było więcej).`,
    args: z
      .object({
        query: z.string().min(1).max(300).describe("ścieżka albo fragment, np. /api/orders/{id}, orders, OrdersController"),
        method: HttpMethod.optional().describe("tylko endpointy tej metody HTTP (i bez metody)"),
      })
      .strict(),
    result: FindEndpointResult,
  },
} satisfies Record<string, McpTool>;

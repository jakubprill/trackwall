import { z } from "zod";
import { MiseTasks } from "./mise.ts";
import { SyncRepo } from "./sync.ts";
import { Commit, Repo, RepoId, RepoOverview } from "./workspace.ts";

/**
 * Kontrakt narzędzi MCP daemona (§5.3, ADR-22): wejście i wynik każdego narzędzia jako schematy zod. Daemon
 * ogłasza z nich JSON Schema w `tools/list` i sprawdza nimi argumenty oraz `structuredContent`, a testy i klienty
 * parsują nimi odpowiedź. Narzędzia tylko czytają; nazwy narzędzi i pól po angielsku (AGENTS.md).
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

/** Repo z listy (`Repo`) i jego wynik w ostatniej synchronizacji od startu daemona; `null`, gdy go w niej nie było. */
export const RepoWithLastSync = Repo.extend({ lastSync: LastSync.nullable() });
export type RepoWithLastSync = z.infer<typeof RepoWithLastSync>;

export const ListReposResult = z.object({
  /** Pełna ścieżka folderu z projektami; `null`, dopóki użytkownik go nie ustawi, a wtedy lista jest pusta. */
  projectsDir: z.string().nullable(),
  repos: z.array(RepoWithLastSync),
});
export type ListReposResult = z.infer<typeof ListReposResult>;

export const GetRepoArgs = z.object({ repo: RepoId.describe("identyfikator repo z list_repos (pole id)") }).strict();
export type GetRepoArgs = z.infer<typeof GetRepoArgs>;

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

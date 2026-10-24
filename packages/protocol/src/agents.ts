import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { RunState } from "./procs.ts";
import { TaskStateChange } from "./task-state.ts";
import { CommitHash, RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `agents` (§4.4, ADR-26): sesje Copilot CLI w PTY należącym do daemona, kilka naraz. Każda akcja
 * to `POST /api/agents/<akcja>`, a terminal sesji to WebSocket `/ws/pty/<sesja>` (§5.2). Klient wskazuje repo
 * identyfikatorem; komendę Copilot CLI składa daemon (§1.2).
 */

export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

/** Zadanie (ADR-31): polecenie dla agenta w osobnym worktree na własnej gałęzi. Ten sam UUID nosi sesja Copilot CLI zadania. */
export const TaskId = z.uuid();
export type TaskId = z.infer<typeof TaskId>;

/**
 * Polecenie zadania. Idzie do Copilot CLI jednym argumentem (`--interactive=<polecenie>`), a wiersz poleceń Windowsa
 * mieści 32 767 znaków razem z resztą komendy.
 */
export const TaskPrompt = z.string().trim().min(1).max(8000);

export const Session = z.object({
  id: SessionId,
  repo: RepoId,
  /** ISO 8601. */
  startedAt: z.string(),
  /** Grupa procesów sesji: `running`, `stopping`, a po końcu kod wyjścia i ostatnie linie ekranu. */
  run: RunState,
  /** Ostatnia zmiana stanu; `null`, dopóki sesja nie dała żadnego sygnału. */
  state: TaskStateChange.nullable(),
  /** Tytuł okna z OSC 0 / 2: nad czym agent pracuje. */
  windowTitle: z.string().nullable(),
  /**
   * Czeka na Ciebie: działa, a stan to `Input`, `Approval` albo `Plan`. Liczy to daemon, żeby UI i tray w powłoce
   * (Rust) czytały jedną regułę zamiast jej kopii.
   */
  needsAttention: z.boolean(),
  /** Zadanie, w którego worktree działa sesja; `null` dla sesji w korzeniu repo. */
  task: TaskId.nullable(),
});
export type Session = z.infer<typeof Session>;

export const Task = z.object({
  id: TaskId,
  repo: RepoId,
  prompt: z.string(),
  /** Gałąź zadania, `trackwall/<skrót polecenia>-<6 znaków identyfikatora>`. */
  branch: z.string(),
  /** Gałąź, od której zadanie wyszło (domyślna repo); `null`, gdy repo nie miało gałęzi domyślnej ani wybranej. */
  baseBranch: z.string().nullable(),
  /** Commit bazowy: zmiany zadania to różnica między nim a katalogiem roboczym worktree. */
  base: CommitHash,
  /** Pełna ścieżka worktree w katalogu stanu (`worktrees/<repo>/<gałąź bez prefiksu>`). */
  worktree: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type Task = z.infer<typeof Task>;

/**
 * Najnowsze sesje na górze; sesje zakończone zostają na liście, dopóki użytkownik ich nie zamknie (`dismiss`).
 * Zadania (od najnowszego) zostają, dopóki użytkownik ich nie zakończy, także po restarcie daemona; sesja zadania to
 * najnowsza sesja z jego `Session.task` (po restarcie daemona żadnej).
 */
export const SessionList = z.object({
  sessions: z.array(Session),
  tasks: z.array(Task),
  /** Katalog worktree zadań; UI podpowiada go do zaufanych folderów Copilot CLI, bo zaufanie obejmuje podkatalogi. */
  worktreesDir: z.string(),
});
export type SessionList = z.infer<typeof SessionList>;

/** Plik zmieniony w worktree względem commita bazowego; `null` w liczbie linii dla pliku binarnego. */
export const ChangedFile = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/**
 * Zmiany zadania: katalog roboczy worktree (z nowymi plikami, bez ignorowanych) względem commita bazowego, czyli
 * commity zadania i to, czego agent jeszcze nie zacommitował, razem.
 */
export const TaskChanges = z.object({
  files: z.array(ChangedFile),
  /** Zunifikowany diff, ucięty do 1 MB (`truncated`). */
  patch: z.string(),
  truncated: z.boolean(),
  /** Commity na gałęzi zadania od commita bazowego. */
  commits: z.number().int().nonnegative(),
  /** Wpisy `git status`: zmienione, nowe i usunięte pliki, których nie ma w żadnym commicie. */
  uncommitted: z.number().int().nonnegative(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/agents/${action}`, request, data };
}

const SessionRequest = z.object({ session: SessionId }).strict();
const TaskRequest = z.object({ task: TaskId }).strict();

export const agentsApi = {
  sessions: endpoint("sessions", z.object({}).strict(), SessionList),
  /** Uruchamia Copilot CLI w korzeniu repo, z wtyczką sesji (ADR-17). */
  start: endpoint("start", z.object({ repo: RepoId }).strict(), Session),
  /** Wraca po potwierdzeniu, że żaden proces sesji nie żyje; zakończona sesja zwraca swój stan. */
  stop: endpoint("stop", SessionRequest, Session),
  /** Usuwa zakończoną sesję z listy; działającej nie da się zamknąć bez zatrzymania. */
  dismiss: endpoint("dismiss", SessionRequest, SessionList),
  /** Tworzy worktree na nowej gałęzi od gałęzi domyślnej i uruchamia w nim Copilot CLI z poleceniem (ADR-31). */
  createTask: endpoint("create-task", z.object({ repo: RepoId, prompt: TaskPrompt }).strict(), Task),
  /** Nowa sesja zadania, które nie ma działającej sesji: Copilot CLI wznawia rozmowę zadania (`--resume`). */
  resumeTask: endpoint("resume-task", TaskRequest, Task),
  taskChanges: endpoint("task-changes", TaskRequest, TaskChanges),
  openTaskEditor: endpoint("open-task-editor", TaskRequest, Done),
  /**
   * Zakończenie zadania: usuwa worktree, a bez `keepBranch` także gałąź. Zmiany, które by przepadły (niezacommitowane
   * pliki i commity spoza gałęzi, a bez `keepBranch` także commity zadania), daemon usuwa tylko z `discardChanges`;
   * inaczej `unsaved_changes`.
   */
  removeTask: endpoint("remove-task", z.object({ task: TaskId, keepBranch: z.boolean(), discardChanges: z.boolean() }).strict(), Done),
};

/** Ścieżka WebSocketu terminala sesji: `/ws/pty/<sesja>` (§5.2). */
export const PTY_SOCKET_PREFIX = "/ws/pty/";

/**
 * Podprotokół WebSocketu terminala. Przeglądarka nie ustawi nagłówka `Authorization` przy WebSocket, więc token
 * daemona idzie jako drugi podprotokół (`bearer.<token>`), a nie w adresie, który trafia do logów i historii.
 */
export const PTY_SUBPROTOCOL = "trackwall.pty";
export const PTY_TOKEN_PREFIX = "bearer.";

/**
 * Kody zamknięcia WebSocketu terminala z zakresu aplikacji (4000–4999), żeby okno terminala odróżniło koniec sesji
 * od zerwania połączenia. Sesji nie ma (nieznana albo zamknięta przez `dismiss`): okno nie łączy się ponownie. */
export const PTY_CLOSE_NOT_FOUND = 4404;
/** Okno nie odbiera wyjścia (ponad 8 MB w buforze daemona); łączy się ponownie od obrazu ekranu. */
export const PTY_CLOSE_SLOW = 4429;

/**
 * Ramki od klienta (tekst JSON). Daemon wysyła wyjście terminala ramkami binarnymi, a po podłączeniu najpierw obraz
 * ekranu (ramka tekstowa), od którego klient zaczyna.
 */
export const PtyClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(10).max(1000), rows: z.number().int().min(4).max(500) }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;

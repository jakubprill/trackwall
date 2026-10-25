import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { WorkingTreeChanges } from "./changes.ts";
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
export const TASK_PROMPT_MAX = 8000;
export const TaskPrompt = z.string().trim().min(1).max(TASK_PROMPT_MAX);
/** The longest reason for rejecting a task proposal (ADR-55): a few sentences for the session that proposed it. */
export const REJECTION_REASON_MAX = 1000;

/**
 * Tytuł zadania (ADR-39): krótki opis na liście sesji, który nadaje sesja proponująca zadanie, tak jak tytuł wątku.
 * Jedna linia bez znaków sterujących, bo UI pokazuje go jako tekst w jednym wierszu.
 */
export const TASK_TITLE_MAX = 80;
export const TaskTitle = z
  .string()
  .trim()
  .min(1)
  .max(TASK_TITLE_MAX)
  // `refine` zamiast `regex` z tego samego powodu co w `visibleText`.
  .refine((value) => !/\p{Cc}/u.test(value), { message: "the title must be a single line without control characters" });

/**
 * Tekst od agenta, który człowiek czyta przed decyzją albo który trafia do innego agenta (propozycja zadania,
 * podsumowanie, ADR-39): bez znaków, których w UI nie widać, a model je czyta (znaki formatujące, w tym znaczniki
 * U+E0000–E007F i zmiana kierunku tekstu, prywatne i separatory linii; nieprzypisanych nie, bo to, co jest nieprzypisane, zależy od tablic Unicode silnika, a Bun i
 * Node mają różne). Inaczej polecenie, które
 * w panelu wygląda niewinnie, mogłoby nieść ukryte instrukcje dla sesji zadania (§8). Tekst wpisany w UI tego nie
 * potrzebuje, bo człowiek pisze go sam.
 */
export function visibleText(text: z.ZodString): z.ZodString {
  // `refine` zamiast `regex`: wzorzec trafiłby do JSON Schema narzędzia MCP, a klient, który kompiluje go bez flagi `u`,
  // czytałby `\p{Cf}` jako zwykłe litery i odrzucał zwykły tekst.
  return text.refine((value) => !/[\p{Cf}\p{Co}\u2028\u2029]/u.test(value), {
    message: "the text must not contain invisible characters (format or private-use characters, line separators)",
  });
}

/** Podsumowanie zadania od jego sesji (`report_result`, ADR-39): co zrobiła i co zostało, dla sesji, która zleciła zadanie. */
export const TASK_SUMMARY_MAX = 4000;
export const TaskSummaryText = z.string().trim().min(1).max(TASK_SUMMARY_MAX);

/**
 * Kto zaproponował zadanie (ADR-39): sesja Trackwall po swoim tokenie sesji albo `null` dla agenta spoza Trackwall
 * (agent nadrzędny z tokenem daemona).
 */
export const ProposedBy = z.object({
  session: SessionId.nullable(),
  /**
   * The proposing session was the supervisor (ADR-58). Kept with the task, so that the supervisor's work stays under
   * it in the Sessions view after the supervisor session that proposed it is gone (closed, or the daemon restarted).
   * Absent in task files from before ADR-58.
   */
  supervisor: z.boolean().default(false),
});
export type ProposedBy = z.infer<typeof ProposedBy>;

export const Session = z.object({
  id: SessionId,
  /** The repo the session works in; `null` for the supervisor, which runs in the projects folder above all repos (ADR-58). */
  repo: RepoId.nullable(),
  /** ISO 8601. */
  startedAt: z.string(),
  /** Grupa procesów sesji: `running`, `stopping`, a po końcu kod wyjścia i ostatnie linie ekranu. */
  run: RunState,
  /** Ostatnia zmiana stanu; `null`, dopóki sesja nie dała żadnego sygnału. */
  state: TaskStateChange.nullable(),
  /** Tytuł okna z OSC 0 / 2: nad czym agent pracuje. */
  windowTitle: z.string().nullable(),
  /**
   * Waiting for you: the session runs and is in `Approval` or `Plan`, or in `Input` the user has not seen yet (ADR-47).
   * The daemon computes it so that the UI and the tray in the shell (Rust) read one rule instead of copies of it.
   */
  needsAttention: z.boolean(),
  /** Zadanie, w którego worktree działa sesja; `null` dla sesji w korzeniu repo. */
  task: TaskId.nullable(),
});
export type Session = z.infer<typeof Session>;

/** The supervisor (ADR-58) is the session without a repo: it runs in the projects folder, above all repos. */
export function isSupervisor(session: Pick<Session, "repo">): boolean {
  return session.repo === null;
}

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
  /** Tytuł z propozycji zadania; `null` dla zadania wpisanego w UI, które UI pokazuje po poleceniu. */
  title: z.string().nullable(),
  /** Skąd zadanie: z zatwierdzonej propozycji (`ProposedBy`) albo `null`, gdy wpisał je użytkownik. */
  proposedBy: ProposedBy.nullable(),
  /** Ostatnie podsumowanie od sesji zadania (`report_result`); `null`, dopóki go nie zgłosiła. */
  summary: z.object({ text: z.string(), reportedAt: z.string() }).nullable(),
});
export type Task = z.infer<typeof Task>;

/**
 * Propozycja zadania (ADR-39): zadanie, które sesja albo agent spoza Trackwall zgłosił narzędziem MCP `propose_task`.
 * Nic się nie uruchamia, dopóki użytkownik jej nie zatwierdzi w widoku Sessions; zatwierdzona staje się zadaniem
 * z tym samym identyfikatorem, odrzucona znika. Żyje tylko w pamięci daemona, jak sesja, która ją zgłosiła.
 */
export const TaskProposal = z.object({
  /** Identyfikator, który dostanie zadanie po zatwierdzeniu. */
  id: TaskId,
  repo: RepoId,
  title: z.string(),
  prompt: z.string(),
  proposedBy: ProposedBy,
  /** ISO 8601. */
  createdAt: z.string(),
});
export type TaskProposal = z.infer<typeof TaskProposal>;

/**
 * Najnowsze sesje na górze; sesje zakończone zostają na liście, dopóki użytkownik ich nie zamknie (`dismiss`).
 * Zadania (od najnowszego) zostają, dopóki użytkownik ich nie zakończy, także po restarcie daemona; sesja zadania to
 * najnowsza sesja z jego `Session.task` (po restarcie daemona żadnej).
 */
export const SessionList = z.object({
  sessions: z.array(Session),
  tasks: z.array(Task),
  /** Propozycje zadań czekające na decyzję użytkownika, od najnowszej. */
  proposals: z.array(TaskProposal),
  /** Katalog worktree zadań; UI podpowiada go do zaufanych folderów Copilot CLI, bo zaufanie obejmuje podkatalogi. */
  worktreesDir: z.string(),
});
export type SessionList = z.infer<typeof SessionList>;

/**
 * Zmiany zadania: katalog roboczy worktree (z nowymi plikami, bez ignorowanych) względem commita bazowego, czyli
 * commity zadania i to, czego agent jeszcze nie zacommitował, razem.
 */
export const TaskChanges = WorkingTreeChanges.extend({
  /** Commity na gałęzi zadania od commita bazowego. */
  commits: z.number().int().nonnegative(),
  /** Wpisy `git status`: zmienione, nowe i usunięte pliki, których nie ma w żadnym commicie. */
  uncommitted: z.number().int().nonnegative(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

/** Tyle plików mieści się w kontekście agenta razem z resztą wyniku; więcej to zwykle wynik buildu bez `.gitignore`. */
export const TASK_SUMMARY_MAX_FILES = 200;

/**
 * Zmiany zadania bez diffu dla kontekstu agenta: pliki z liczbą linii (najwyżej `TASK_SUMMARY_MAX_FILES`;
 * `filesTruncated`, gdy było więcej) i liczby commitów, bez treści zmian.
 */
export const TaskChangesSummary = TaskChanges.omit({ patch: true, truncated: true }).extend({ filesTruncated: z.boolean() });
export type TaskChangesSummary = z.infer<typeof TaskChangesSummary>;

/** The smallest diff limit an agent may ask for in `get_task_changes`: less does not hold a file header and a hunk. */
export const AGENT_PATCH_MIN_BYTES = 1000;
/**
 * The default and the largest diff limit in one `get_task_changes` result: small next to the 1 MB of the "Changes"
 * tab, because the result reaches the agent twice (text and `structuredContent`).
 */
export const AGENT_PATCH_DEFAULT_BYTES = 32_000;
export const AGENT_PATCH_MAX_BYTES = 200_000;

/**
 * A task's changes for an agent with their diff (`get_task_changes`): `TaskChanges` narrowed to the requested paths,
 * with the diff cut within the agent's byte limit and at most `TASK_SUMMARY_MAX_FILES` files (`filesTruncated`).
 */
export const AgentTaskChanges = TaskChanges.extend({ filesTruncated: z.boolean() });
export type AgentTaskChanges = z.infer<typeof AgentTaskChanges>;

/**
 * Shared files of a task (ADR-44): files that both this task and another task of the same repo change, each compared
 * with its own base commit. The task merged second will likely get a conflict in them.
 */
export const TaskSharedFiles = z.object({
  /** The other task. */
  task: TaskId,
  /** Paths relative to the repo root, as in `ChangedFile.path`. */
  files: z.array(z.string()),
});
export type TaskSharedFiles = z.infer<typeof TaskSharedFiles>;

export const SharedFilesList = z.object({ shared: z.array(TaskSharedFiles) });
export type SharedFilesList = z.infer<typeof SharedFilesList>;

/** How one file of the mise config in a task's worktree differs from the trusted one (ADR-59). */
export const MiseConfigChange = z.object({
  /** Relative to the worktree root, with `/`. */
  path: z.string(),
  change: z.enum(["added", "modified", "removed"]),
  /** The file's text, to be read before trusting it; `null` for a removed file or one too long to show. */
  content: z.string().nullable(),
});
export type MiseConfigChange = z.infer<typeof MiseConfigChange>;

/**
 * The mise config of a task's worktree against the one the user trusted (ADR-59): the mise files as the worktree was
 * created, or as the user trusted them later. mise tasks run in the worktree only without changes.
 */
export const TaskMiseConfig = z.object({
  /**
   * No config of this worktree was ever trusted (a task from an older Trackwall, or one whose config could not be read
   * when it was created): every mise file is a change.
   */
  neverTrusted: z.boolean(),
  /** Sorted by path; empty when the worktree has the trusted mise config. */
  changes: z.array(MiseConfigChange),
  /** A hash of the current mise files: trusting passes it back, so the user trusts the config they saw, not a newer one. */
  digest: z.string(),
});
export type TaskMiseConfig = z.infer<typeof TaskMiseConfig>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/agents/${action}`, request, data };
}

const SessionRequest = z.object({ session: SessionId }).strict();
const TaskRequest = z.object({ task: TaskId }).strict();
const ProposalRequest = z.object({ proposal: TaskId }).strict();

export const agentsApi = {
  sessions: endpoint("sessions", z.object({}).strict(), SessionList),
  /** Uruchamia Copilot CLI w korzeniu repo, z wtyczką sesji (ADR-17). */
  start: endpoint("start", z.object({ repo: RepoId }).strict(), Session),
  /**
   * Starts the supervisor (ADR-58): Copilot CLI in the projects folder, above the sessions of all repos. There is at
   * most one running at a time, so while one runs this returns it instead of starting another.
   */
  startSupervisor: endpoint("start-supervisor", z.object({}).strict(), Session),
  /** Wraca po potwierdzeniu, że żaden proces sesji nie żyje; zakończona sesja zwraca swój stan. */
  stop: endpoint("stop", SessionRequest, Session),
  /** Usuwa zakończoną sesję z listy; działającej nie da się zamknąć bez zatrzymania. */
  dismiss: endpoint("dismiss", SessionRequest, SessionList),
  /** Tworzy worktree na nowej gałęzi od gałęzi domyślnej i uruchamia w nim Copilot CLI z poleceniem (ADR-31). */
  createTask: endpoint("create-task", z.object({ repo: RepoId, prompt: TaskPrompt }).strict(), Task),
  /** Nowa sesja zadania, które nie ma działającej sesji: Copilot CLI wznawia rozmowę zadania (`--resume`). */
  resumeTask: endpoint("resume-task", TaskRequest, Task),
  taskChanges: endpoint("task-changes", TaskRequest, TaskChanges),
  /** Other tasks of the same repo that change the same files (ADR-44); tasks whose changes cannot be read are left out. */
  taskSharedFiles: endpoint("task-shared-files", TaskRequest, SharedFilesList),
  openTaskEditor: endpoint("open-task-editor", TaskRequest, Done),
  /** The worktree's mise config against the trusted one (ADR-59). */
  taskMiseConfig: endpoint("task-mise-config", TaskRequest, TaskMiseConfig),
  /**
   * The user trusts the worktree's current mise config (ADR-59), named by its `digest` from `task-mise-config`; a config
   * that changed again since then is `bad_request`. Only from the UI, never from MCP.
   */
  trustTaskMiseConfig: endpoint("trust-task-mise-config", TaskRequest.extend({ digest: z.string().min(1).max(128) }), TaskMiseConfig),
  /**
   * Zakończenie zadania: usuwa worktree, a bez `keepBranch` także gałąź. Zmiany, które by przepadły (niezacommitowane
   * pliki i commity spoza gałęzi, a bez `keepBranch` także commity zadania), daemon usuwa tylko z `discardChanges`;
   * inaczej `unsaved_changes`.
   */
  removeTask: endpoint("remove-task", z.object({ task: TaskId, keepBranch: z.boolean(), discardChanges: z.boolean() }).strict(), Done),
  /**
   * Zatwierdzenie propozycji zadania (ADR-39): zadanie z jej identyfikatorem, jak `create-task`, z poleceniem, które
   * użytkownik mógł poprawić przed startem. Nieudany start zostawia propozycję do ponownej próby albo odrzucenia.
   */
  approveProposal: endpoint("approve-proposal", ProposalRequest.extend({ prompt: TaskPrompt }), Task),
  /**
   * Rejects a proposal: it leaves the list, and a session waiting on it gets `proposal_rejected` with the user's reason
   * when they gave one (ADR-55); an empty reason is no reason.
   */
  rejectProposal: endpoint(
    "reject-proposal",
    ProposalRequest.extend({
      reason: z
        .string()
        .trim()
        .max(REJECTION_REASON_MAX)
        .optional()
        .transform((reason) => (reason === "" ? undefined : reason)),
    }),
    Done,
  ),
};

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
  /** The window is (or stops being) in front of the user: focused and visible. A focused window marks the session seen (ADR-47). */
  z.object({ type: z.literal("focus"), focused: z.boolean() }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;

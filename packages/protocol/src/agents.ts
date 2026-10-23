import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { RunState } from "./procs.ts";
import { TaskStateChange } from "./task-state.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `agents` (§4.4, ADR-26): sesje Copilot CLI w PTY należącym do daemona, kilka naraz. Każda akcja
 * to `POST /api/agents/<akcja>`, a terminal sesji to WebSocket `/ws/pty/<sesja>` (§5.2). Klient wskazuje repo
 * identyfikatorem; komendę Copilot CLI składa daemon (§1.2).
 */

export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

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
});
export type Session = z.infer<typeof Session>;

/** Najnowsze sesje na górze; sesje zakończone zostają na liście, dopóki użytkownik ich nie zamknie (`dismiss`). */
export const SessionList = z.object({ sessions: z.array(Session) });
export type SessionList = z.infer<typeof SessionList>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/agents/${action}`, request, data };
}

const SessionRequest = z.object({ session: SessionId }).strict();

export const agentsApi = {
  sessions: endpoint("sessions", z.object({}).strict(), SessionList),
  /** Uruchamia Copilot CLI w korzeniu repo, z wtyczką sesji (ADR-17). */
  start: endpoint("start", z.object({ repo: RepoId }).strict(), Session),
  /** Wraca po potwierdzeniu, że żaden proces sesji nie żyje; zakończona sesja zwraca swój stan. */
  stop: endpoint("stop", SessionRequest, Session),
  /** Usuwa zakończoną sesję z listy; działającej nie da się zamknąć bez zatrzymania. */
  dismiss: endpoint("dismiss", SessionRequest, SessionList),
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

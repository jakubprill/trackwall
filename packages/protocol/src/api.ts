import { z } from "zod";

/** Kody błędów wspólne dla wszystkich modułów API. */
export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden_origin",
  "not_found",
  "bad_request",
  /** Repo z workspace jest niedostępne (git odmówił, np. uszkodzone `.git`); szczegóły w `message`. */
  "repo_unavailable",
  /** Folder z projektami z `workspace.yaml` nie istnieje albo nie jest katalogiem (np. odłączony dysk). */
  "projects_dir_unavailable",
  /** `workspace.yaml` nie przechodzi walidacji; użytkownik musi go poprawić ręcznie. */
  "invalid_config",
  /** Nie da się uruchomić taska mise: brak mise, konfiguracja bez zaufania albo błąd mise; szczegóły w `message`. */
  "mise_unavailable",
  /** Po zatrzymaniu z eskalacją część grupy procesów nadal żyje; daemon nie zgłasza zatrzymania, którego nie widział. */
  "stop_unconfirmed",
  /** Nie da się uruchomić sesji agenta: brak Copilot CLI w `PATH` albo PTY w tym runtime (daemon pod Node, ADR-26). */
  "agent_unavailable",
  /** Zakończenie zadania skasowałoby zmiany (niezacommitowane pliki albo commity), a wołający tego nie potwierdził. */
  "unsaved_changes",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Koperta każdej odpowiedzi HTTP: `{ ok, data }` albo `{ ok: false, error }`. */
export function apiResult<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data }), z.object({ ok: z.literal(false), error: ApiError })]);
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/**
 * Token daemona w WebSocketach (`/ws`, `/ws/pty/<sesja>`, §5.2). Przeglądarka nie ustawi nagłówka `Authorization`
 * przy WebSocket, więc token idzie jako drugi podprotokół (`bearer.<token>`), a nie w adresie, który trafia do logów
 * i historii; serwer potwierdza tylko podprotokół gniazda.
 */
export const SOCKET_TOKEN_PREFIX = "bearer.";

/**
 * Akcja `POST /api/<moduł>/<akcja>` (§5.2): ścieżka, schemat ciała i schemat wyniku w jednym obiekcie,
 * z którego korzystają i daemon (walidacja wejścia), i klienty (typ ciała, walidacja odpowiedzi).
 */
export interface Endpoint<Req extends z.ZodType = z.ZodType, Data extends z.ZodType = z.ZodType> {
  path: string;
  request: Req;
  /** Schemat pola `data` w odpowiedzi `{ ok: true, data }`. */
  data: Data;
}

/** Wynik akcji, która nic nie zwraca (`data: null`). */
export const Done = z.null();

/** Koperta odpowiedzi bez znajomości `data`; klient sprawdza `data` schematem akcji w drugim kroku. */
export const ApiEnvelope = apiResult(z.unknown());

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

/** Zdarzenie na WebSocket `/ws`. Typy zdarzeń dochodzą w kolejnych etapach. */
export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

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

/** Koperta odpowiedzi bez znajomości `data`; klient sprawdza `data` schematem akcji w drugim kroku. */
export const ApiEnvelope = apiResult(z.unknown());

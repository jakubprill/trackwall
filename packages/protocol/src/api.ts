import { z } from "zod";

/** Kody błędów wspólne dla wszystkich modułów API. */
export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden_origin",
  "not_found",
  "bad_request",
  /** Repo z workspace jest niedostępne (katalog zniknął, git odmówił); szczegóły w `message`. */
  "repo_unavailable",
  /** `workspace.yaml` nie przechodzi walidacji; użytkownik musi go poprawić ręcznie. */
  "invalid_config",
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

import { z } from "zod";

/** Error codes shared by all API modules. */
export const ErrorCode = z.enum([
  "unauthorized",
  "forbidden_origin",
  "not_found",
  "bad_request",
  /** A repo from the workspace is unavailable (git refused, for example a damaged `.git`); details in `message`. */
  "repo_unavailable",
  /** The projects folder from `workspace.yaml` does not exist or is not a directory (for example a disconnected drive). */
  "projects_dir_unavailable",
  /** `workspace.yaml` fails validation; the user has to fix it by hand. */
  "invalid_config",
  /** A mise task cannot be run: mise is missing, the config is not trusted, or mise failed; details in `message`. */
  "mise_unavailable",
  /** After a stop with escalation part of the process group is still alive; the daemon does not report a stop it has not seen. */
  "stop_unconfirmed",
  /** An agent session cannot be started: no Copilot CLI in `PATH` or no PTY in this runtime (the daemon under Node, ADR-26). */
  "agent_unavailable",
  /** Ending the task would delete changes (uncommitted files or commits), and the caller has not confirmed that. */
  "unsaved_changes",
  /** A service is not running or not ready (no port answers yet), or its port is taken by a process Trackwall did not start (ADR-45). */
  "service_unavailable",
  /**
   * The agent dialog an answer names is no longer on the session's screen (ADR-66): it was answered in the terminal, the
   * agent moved on, or the dialog changed; nothing was typed.
   */
  "dialog_changed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

/** The envelope of every HTTP response: `{ ok, data }` or `{ ok: false, error }`. */
export function apiResult<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data }), z.object({ ok: z.literal(false), error: ApiError })]);
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/**
 * An action `POST /api/<module>/<action>` (§5.2): the path, the body schema and the result schema in one object,
 * used by both the daemon (input validation) and the clients (body type, response validation).
 */
export interface Endpoint<Req extends z.ZodType = z.ZodType, Data extends z.ZodType = z.ZodType> {
  path: string;
  request: Req;
  /** Schema of the `data` field in the response `{ ok: true, data }`. */
  data: Data;
}

/** The result of an action that returns nothing (`data: null`). */
export const Done = z.null();

/** The response envelope without knowing `data`; the client checks `data` with the action's schema in a second step. */
export const ApiEnvelope = apiResult(z.unknown());

import { ApiEnvelope, type Endpoint, type ErrorCode } from "@trackwall/protocol";
import type { z } from "zod";
import type { Connection } from "./connection.ts";

/** Codes from the daemon's `ErrorCode` and `bad_response` when a response does not match the contract. */
export type CallErrorCode = ErrorCode | "bad_response";

class ApiCallError extends Error {
  readonly code: CallErrorCode;

  constructor(code: CallErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** An API call: the envelope `{ ok, data }`, then `data` checked with the same zod schema the daemon uses. */
export async function call<S extends z.ZodType>(conn: Connection, path: string, data: S, init: RequestInit = {}): Promise<z.output<S>> {
  const res = await send(conn, path, init);
  const envelope = await envelopeOf(res, path);
  if (!envelope.ok) throw new ApiCallError(envelope.error.code, envelope.error.message);
  const parsed = data.safeParse(envelope.data);
  if (!parsed.success) throw new ApiCallError("bad_response", `response from ${path} does not match the contract`);
  return parsed.data;
}

/** An action `POST /api/<module>/<action>` (§5.2): the body and result types follow from `endpoint`. */
export function post<Req extends z.ZodType, Data extends z.ZodType>(
  conn: Connection,
  endpoint: Endpoint<Req, Data>,
  body: z.input<Req>,
): Promise<z.output<Data>> {
  return call(conn, endpoint.path, endpoint.data, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * An action whose answer is a file's bytes rather than `{ ok, data }` (`terminals/download`, ADR-187); a refusal still
 * comes as the envelope and throws like `call`.
 */
export async function download(conn: Connection, path: string, body: unknown): Promise<Blob> {
  const res = await send(conn, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return res.blob();
  const envelope = await envelopeOf(res, path);
  throw envelope.ok
    ? new ApiCallError("bad_response", `unexpected response ${res.status} from ${path}`)
    : new ApiCallError(envelope.error.code, envelope.error.message);
}

/** A request to the daemon with its token. */
function send(conn: Connection, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (conn.token) headers.set("authorization", `Bearer ${conn.token}`);
  return fetch(`${conn.baseUrl}${path}`, { ...init, headers });
}

/** The answer's `{ ok, ... }` envelope; `bad_response` when it is not one. */
async function envelopeOf(res: Response, path: string): Promise<z.output<typeof ApiEnvelope>> {
  const envelope = ApiEnvelope.safeParse(await res.json().catch(() => undefined));
  if (!envelope.success) throw new ApiCallError("bad_response", `unexpected response ${res.status} from ${path}`);
  return envelope.data;
}

/** The API error code (`error.code`) when the error came from the daemon. */
export function errorCode(err: unknown): CallErrorCode | undefined {
  return err instanceof ApiCallError ? err.code : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

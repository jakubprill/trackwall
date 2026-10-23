import { ApiEnvelope, type Endpoint, type ErrorCode } from "@trackwall/protocol";
import type { z } from "zod";
import type { Connection } from "./connection.ts";

/** Kody z `ErrorCode` daemona i `bad_response`, gdy odpowiedź nie zgadza się z kontraktem. */
export type CallErrorCode = ErrorCode | "bad_response";

class ApiCallError extends Error {
  readonly code: CallErrorCode;

  constructor(code: CallErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Wywołanie API: koperta `{ ok, data }`, potem `data` sprawdzone tym samym schematem zod, którego używa daemon. */
export async function call<S extends z.ZodType>(conn: Connection, path: string, data: S, init: RequestInit = {}): Promise<z.output<S>> {
  const headers = new Headers(init.headers);
  if (conn.token) headers.set("authorization", `Bearer ${conn.token}`);
  const res = await fetch(`${conn.baseUrl}${path}`, { ...init, headers });
  const envelope = ApiEnvelope.safeParse(await res.json().catch(() => undefined));
  if (!envelope.success) throw new ApiCallError("bad_response", `nieoczekiwana odpowiedź ${res.status} z ${path}`);
  if (!envelope.data.ok) throw new ApiCallError(envelope.data.error.code, envelope.data.error.message);
  const parsed = data.safeParse(envelope.data.data);
  if (!parsed.success) throw new ApiCallError("bad_response", `odpowiedź z ${path} nie zgadza się z kontraktem`);
  return parsed.data;
}

/** Akcja `POST /api/<moduł>/<akcja>` (§5.2): typ ciała i wyniku wynika z `endpoint`. */
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

/** Kod błędu API (`error.code`), gdy błąd przyszedł od daemona. */
export function errorCode(err: unknown): CallErrorCode | undefined {
  return err instanceof ApiCallError ? err.code : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

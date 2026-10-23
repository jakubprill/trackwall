import type { ApiResult } from "@pitwall/protocol";
import type { z } from "zod";
import type { Connection } from "./connection.ts";

class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Wywołanie API z walidacją odpowiedzi tym samym schematem zod, którego używa daemon. */
export async function call<T>(conn: Connection, path: string, schema: z.ZodType<ApiResult<T>>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (conn.token) headers.set("authorization", `Bearer ${conn.token}`);
  const res = await fetch(`${conn.baseUrl}${path}`, { ...init, headers });
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiCallError("bad_response", `nieoczekiwana odpowiedź ${res.status} z ${path}`);
  if (!parsed.data.ok) throw new ApiCallError(parsed.data.error.code, parsed.data.error.message);
  return parsed.data.data;
}

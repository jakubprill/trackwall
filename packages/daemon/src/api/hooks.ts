import type { IncomingMessage, ServerResponse } from "node:http";
import type { CopilotHookEvent } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { SESSION_TOKEN_HEADER, sessionRequest } from "../mcp/endpoint.ts";
import { readBody } from "./body.ts";

/**
 * The session plugin's hooks over HTTP (§5.2, ADR-88): Copilot CLI POSTs each hook's payload to `/hooks/<event>` with
 * the daemon token and the session token, waits for the answer and takes its body as the hook's output. A request
 * instead of a hook process, which an antivirus would scan at every event while the agent waits.
 */

export const HOOKS_PATH = "/hooks/";

/** A payload carries the tool's arguments and result, which can be a whole file; the record keeps only a few fields. */
const MAX_HOOK_BYTES = 32 * 1024 * 1024;

/** What the session plugin's hook for `event` sends, for a daemon whose API listens on `port`. */
export function sessionHookRequest(port: number, token: string, event: CopilotHookEvent, sessionToken: string) {
  return sessionRequest(port, token, sessionToken, `${HOOKS_PATH}${event}`);
}

/** `/hooks/<event>` with the daemon token already checked; the answer is the bare hook output, not an `ApiResult`. */
export async function handleHook(
  req: IncomingMessage,
  res: ServerResponse,
  receive: (sessionToken: string, event: string, payload: string) => Record<string, never>,
): Promise<void> {
  if (req.method !== "POST") throw new DomainError("not_found", `no route ${req.method} ${req.url}`);
  const sessionToken = req.headers[SESSION_TOKEN_HEADER];
  // Before the body, which can be large: a hook from outside a session is refused without reading it.
  if (typeof sessionToken !== "string") throw new DomainError("unauthorized", "missing session token");
  const event = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(HOOKS_PATH.length);
  const payload = (await readBody(req, MAX_HOOK_BYTES)).toString("utf8");
  const output = receive(sessionToken, event, payload);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(output));
}

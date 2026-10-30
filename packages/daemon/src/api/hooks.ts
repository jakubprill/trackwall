import type { IncomingMessage, ServerResponse } from "node:http";
import type { CopilotHookEvent, CopilotHookOutput } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { sessionRequest } from "../mcp/endpoint.ts";
import { readBody } from "./body.ts";

/**
 * The session plugin's hooks over HTTP (§5.2, ADR-88): Copilot CLI POSTs each hook's payload to `/hooks/<event>` with
 * the session token alone (ADR-138), waits for the answer and takes its body as the hook's output. A request
 * instead of a hook process, which an antivirus would scan at every event while the agent waits.
 */

export const HOOKS_PATH = "/hooks/";

/** A payload carries the tool's arguments and result, which can be a whole file; the record keeps only a few fields. */
const MAX_HOOK_BYTES = 32 * 1024 * 1024;

/** What the session plugin's hook for `event` sends, for a daemon whose API listens on `port`. */
export function sessionHookRequest(port: number, event: CopilotHookEvent, sessionToken: string) {
  return sessionRequest(port, sessionToken, `${HOOKS_PATH}${event}`);
}

/**
 * `/hooks/<event>` from `session`, already recognised by its token (`authenticate` in `server.ts`); `null`, the daemon
 * token without a session token, is refused, since a hook belongs to a session. The answer is the bare hook output,
 * not an `ApiResult`.
 */
export async function handleHook(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  session: string | null,
  receive: (session: string, event: string, payload: string) => CopilotHookOutput,
): Promise<void> {
  if (req.method !== "POST") throw new DomainError("not_found", `no route ${req.method} ${path}`);
  if (session === null) throw new DomainError("unauthorized", "missing session token");
  const payload = (await readBody(req, MAX_HOOK_BYTES)).toString("utf8");
  const output = receive(session, path.slice(HOOKS_PATH.length), payload);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(output));
}

/**
 * The hook route for sessions of an `Agents` without the daemon API (`makeAgents`): one server on `127.0.0.1` for the
 * whole test process, which hands a POSTed hook to the `Agents` that started the session, through the API's own
 * `handleHook`. No token is checked here; `session-hooks-api.test.ts` checks them on the real API.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleHook, sessionHookRequest } from "../../src/api/hooks.ts";
import type { CopilotHookEvent } from "../../src/facade.ts";
import { SESSION_TOKEN_HEADER } from "../../src/mcp/endpoint.ts";
import type { Agents } from "../../src/modules/agents/agents.ts";

/** Session token → the `Agents` of its session. */
const owners = new Map<string, Agents>();

const server = createServer((req, res) => {
  const sessionToken = req.headers[SESSION_TOKEN_HEADER];
  const owner = typeof sessionToken === "string" ? owners.get(sessionToken) : undefined;
  const session = typeof sessionToken === "string" ? owner?.callerSession(sessionToken) : undefined;
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (owner === undefined || session === undefined) {
    res.writeHead(401);
    return void res.end();
  }
  handleHook(req, res, path, session, (...args) => owner.receiveHook(...args)).catch(() => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const port = (server.address() as AddressInfo).port;

/** The session hook of `Agents` deps: the hooks of a session go to the `Agents` that `agents` returns. */
export function hookServerFor(agents: () => Agents) {
  return (event: CopilotHookEvent, sessionToken: string) => {
    owners.set(sessionToken, agents());
    return sessionHookRequest(port, event, sessionToken);
  };
}

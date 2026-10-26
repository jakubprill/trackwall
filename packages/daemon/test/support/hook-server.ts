/**
 * The hook route for sessions of an `Agents` without the daemon API (`makeAgents`): one server on `127.0.0.1` for the
 * whole test process, which hands a POSTed hook to the `Agents` that issued its session token, through the API's own
 * `handleHook`. The daemon token is not checked here; `api.test.ts` checks it on the real API.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HOOKS_PATH, handleHook, sessionHookRequest } from "../../src/api/hooks.ts";
import type { CopilotHookEvent } from "../../src/facade.ts";
import type { Agents } from "../../src/modules/agents/agents.ts";

const receivers = new Set<Agents>();

const server = createServer((req, res) => {
  const fail = () => {
    res.writeHead(500);
    res.end();
  };
  if (req.method !== "POST" || !req.url?.startsWith(HOOKS_PATH)) return fail();
  handleHook(req, res, (sessionToken, event, payload) => {
    const owner = [...receivers].find((agents) => agents.callerSession(sessionToken) !== undefined);
    if (owner === undefined) throw new Error("no Agents knows this session token");
    return owner.receiveHook(sessionToken, event, payload);
  }).catch(fail);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const port = (server.address() as AddressInfo).port;

/** Hooks of `agents()`'s sessions go to it; a function, since the hooks are part of the deps `Agents` is built from. */
export function hookServerFor(agents: () => Agents) {
  let registered = false;
  return (event: CopilotHookEvent, sessionToken: string) => {
    if (!registered) receivers.add(agents());
    registered = true;
    return sessionHookRequest(port, "not-checked", event, sessionToken);
  };
}

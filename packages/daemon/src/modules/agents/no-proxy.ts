import { envKey } from "../../infra/env-key.ts";

/**
 * The environment with `127.0.0.1` in `NO_PROXY`, for a program that reaches the daemon over HTTP while the user's
 * `HTTP_PROXY` is set. Copilot CLI's MCP client sends even `127.0.0.1` through the proxy otherwise (ADR-89), and it
 * does not count `localhost` for it. Every spelling the user set gets the address, because a client may read either;
 * without one, `NO_PROXY` is set.
 */
export function withLoopbackNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [...new Set(["NO_PROXY", "no_proxy"].map((name) => envKey(env, name)))].filter((key) => env[key] !== undefined);
  const result = { ...env };
  for (const key of keys.length > 0 ? keys : ["NO_PROXY"]) result[key] = withLoopback(env[key]);
  return result;
}

const LOOPBACK = "127.0.0.1";

function withLoopback(list: string | undefined): string {
  const entries = (list ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.includes(LOOPBACK) ? entries.join(",") : [...entries, LOOPBACK].join(",");
}

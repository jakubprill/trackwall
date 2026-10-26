import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpEndpoint } from "@trackwall/protocol";
import { COPILOT_HOOK_EVENTS, type CopilotHookEvent } from "./copilot-hook-record.ts";

/**
 * The session plugin (§4.4, ADR-17): a directory given to Copilot CLI through `--plugin-dir` that registers the hooks
 * reporting the state. It works only in this one session, so it changes neither the user's configuration (`~/.copilot`)
 * nor files in the repo (`.github/hooks`).
 */

const COPILOT_PLUGIN_NAME = "trackwall-session";

/**
 * A program run without a shell (`exec` + `args`), so paths with spaces need no quoting. `cwd` must be the session
 * plugin's directory, not the repo: Copilot CLI runs hooks in the repo by default, and then e.g. Bun would load
 * `bunfig.toml` and `.env` from the user's repo (someone else's code and secrets in the hook process). Only the recording
 * script uses it; the daemon's sessions get an `HttpHook`.
 */
interface HookCommand {
  type: "command";
  exec: string;
  args: string[];
  cwd: string;
}

/**
 * A POST of the payload to a URL (ADR-88): Copilot CLI starts no process for it, which a process start slowed down by
 * an antivirus would add to every event. Copilot CLI sends it to `127.0.0.1` only with `COPILOT_HOOK_ALLOW_LOCALHOST=1`
 * in its environment and drops it silently otherwise.
 */
interface HttpHook extends HttpEndpoint {
  type: "http";
}

type PluginHook = HookCommand | HttpHook;

/** A state hook must answer at once; waiting longer only slows the agent down. */
const HOOK_TIMEOUT_SEC = 5;

export function writeCopilotPlugin(dir: string, hook: (event: CopilotHookEvent) => PluginHook): void {
  mkdirSync(dir, { recursive: true });
  const manifest = { name: COPILOT_PLUGIN_NAME, version: "0.0.0", description: "Trackwall: task session state" };
  const hooks = Object.fromEntries(COPILOT_HOOK_EVENTS.map((event) => [event, [{ ...hook(event), timeoutSec: HOOK_TIMEOUT_SEC }]]));
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // User-only like the session's `mcp-config.json`: an HTTP hook's headers carry the daemon token and the session token (§8).
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, { mode: 0o600 });
}

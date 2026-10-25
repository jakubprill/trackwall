import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * `bunfig.toml` and `.env` from the user's repo (someone else's code and secrets in the hook process).
 */
export interface HookCommand {
  exec: string;
  args: string[];
  cwd: string;
}

/** A state hook must answer at once; waiting longer only slows the agent down. */
const HOOK_TIMEOUT_SEC = 5;

export function writeCopilotPlugin(dir: string, command: (event: CopilotHookEvent) => HookCommand): void {
  mkdirSync(dir, { recursive: true });
  const manifest = { name: COPILOT_PLUGIN_NAME, version: "0.0.0", description: "Trackwall: task session state" };
  const hooks = Object.fromEntries(
    COPILOT_HOOK_EVENTS.map((event) => [event, [{ type: "command", ...command(event), timeoutSec: HOOK_TIMEOUT_SEC }]]),
  );
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "hooks.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`);
}

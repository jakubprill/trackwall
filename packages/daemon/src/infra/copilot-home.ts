import { homedir } from "node:os";
import { join } from "node:path";
import { envKey } from "./env-key.ts";

/**
 * Copilot CLI's home: `COPILOT_HOME` (in any case on Windows) when set and not empty, otherwise `~/.copilot`. The
 * doctor reads its `config.json` (§4.15), and a session's usage comes from its `session-state` folder (ADR-190).
 */
export function copilotHome(env: NodeJS.ProcessEnv): string {
  const home = env[envKey(env, "COPILOT_HOME")];
  return home ? home : join(homedir(), ".copilot");
}

import { homedir } from "node:os";
import { join } from "node:path";
import { envKey } from "./env-key.ts";

/**
 * Copilot CLI's home: `COPILOT_HOME` (in any case on Windows) when set and not empty, otherwise `~/.copilot`. The
 * doctor reads its `config.json` (§4.15), and a session's usage and the weekly usage report come from its
 * `session-state` folder (ADR-190, ADR-195).
 */
export function copilotHome(env: NodeJS.ProcessEnv): string {
  const home = env[envKey(env, "COPILOT_HOME")];
  return home ? home : join(homedir(), ".copilot");
}

/** The folder of Copilot CLI's conversations, one folder each, named by the conversation's id. */
export function conversationsDir(copilotHome: string): string {
  return join(copilotHome, "session-state");
}

/** The event log of a conversation in Copilot CLI's home. */
export function conversationEventLog(copilotHome: string, conversation: string): string {
  return join(conversationsDir(copilotHome), conversation, EVENT_LOG_FILE);
}

/** A conversation's event log, in its folder. */
export const EVENT_LOG_FILE = "events.jsonl";

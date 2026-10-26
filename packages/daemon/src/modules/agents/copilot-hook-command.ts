import { appendFileSync } from "node:fs";
import { CopilotHookEvent, hookRecord } from "./copilot-hook-record.ts";

/**
 * Appends the hook record of a hook payload to a session's `hooks.jsonl`, where the session reads it (`HookTail`). A
 * payload that is not a JSON object leaves no record. The daemon calls it for the hooks Copilot CLI POSTs to it
 * (ADR-88), the recording script from its own hook program.
 */
export function appendHookRecord(log: string, event: CopilotHookEvent, payload: string): void {
  const r = hookRecord(event, payload, Date.now());
  if (r) appendFileSync(log, `${JSON.stringify(r)}\n`);
}

/**
 * The recording script's hook program (ADR-17): Copilot CLI runs it on an event with a JSON payload on stdin. An error
 * is swallowed and nothing goes to stdout: a state hook must not stop the agent or give it a decision, and a lost record
 * only means a worse state.
 */
export function runCopilotHook(eventArg: string | undefined, log: string | undefined, stdin: string): void {
  try {
    const event = CopilotHookEvent.safeParse(eventArg);
    if (!event.success || !log) return;
    appendHookRecord(log, event.data, stdin);
  } catch {
    // see the function's comment
  }
}

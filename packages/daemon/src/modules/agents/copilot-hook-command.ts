import { appendFileSync } from "node:fs";
import { CopilotHookEvent, hookRecord } from "./copilot-hook-record.ts";

/**
 * The session plugin's hook (ADR-17): a program Copilot CLI runs on an event with a JSON payload on stdin. It appends
 * the hook record to the session's `hooks.jsonl`, where the daemon reads it (`HookTail`). An error is swallowed and
 * nothing goes to stdout: a state hook must not stop the agent or give it a decision, and a lost record only means a worse state.
 */
export function runCopilotHook(eventArg: string | undefined, log: string | undefined, stdin: string): void {
  try {
    const event = CopilotHookEvent.safeParse(eventArg);
    if (!event.success || !log) return;
    const r = hookRecord(event.data, stdin, Date.now());
    if (r) appendFileSync(log, `${JSON.stringify(r)}\n`);
  } catch {
    // see the function's comment
  }
}

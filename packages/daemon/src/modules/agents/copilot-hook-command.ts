import { appendFileSync } from "node:fs";
import { CopilotHookEvent, hookRecord } from "./copilot-hook-record.ts";

/**
 * Hook wtyczki sesji (ADR-17): program, który Copilot CLI uruchamia przy zdarzeniu z payloadem JSON na stdin.
 * Dopisuje rekord hooka do `hooks.jsonl` sesji, skąd czyta go daemon (`HookTail`). Błąd jest połykany i nic nie
 * trafia na stdout: hook stanu nie może zatrzymać agenta ani podać mu decyzji, a zgubiony rekord to tylko gorszy stan.
 */
export function runCopilotHook(eventArg: string | undefined, log: string | undefined, stdin: string): void {
  try {
    const event = CopilotHookEvent.safeParse(eventArg);
    if (!event.success || !log) return;
    const r = hookRecord(event.data, stdin, Date.now());
    if (r) appendFileSync(log, `${JSON.stringify(r)}\n`);
  } catch {
    // patrz komentarz funkcji
  }
}

import type { Session } from "@trackwall/protocol";
import { Gauge } from "lucide-react";
import { tokenBudgetNote } from "@/lib/token-budget";

/**
 * The strip under a task session's header once the daemon stopped it at its token budget (ADR-237), so the stop does
 * not look like the agent's own end. The task's Resume is the way on, so the strip only says what happened.
 */
export function TokenBudgetNotice({ session }: { session: Session }) {
  const note = tokenBudgetNote(session);
  if (note === null) return null;
  return (
    <section aria-label="Token budget" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <Gauge className="text-warning size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{note.title}</span>
      <span className="text-muted-foreground min-w-0">{note.detail}</span>
    </section>
  );
}

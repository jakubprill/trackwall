import type { Session } from "@trackwall/protocol";
import { Bot } from "lucide-react";
import { modelSwitchNote } from "@/lib/model-change";

/**
 * The strip under a session's header when Copilot CLI runs it on another model than the one Trackwall asked for
 * (ADR-225), e.g. a model the account does not offer, which Copilot CLI replaces without an error. The header's Model
 * button is the way to another model, so the strip only names both.
 */
export function ModelSwitchNotice({ session }: { session: Session }) {
  const note = modelSwitchNote(session);
  if (note === null) return null;
  return (
    <section aria-label="Another model" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <Bot className="text-warning size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-mono">{note.title}</span>
      <span className="text-muted-foreground min-w-0">{note.detail}</span>
    </section>
  );
}

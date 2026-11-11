import type { Session } from "@trackwall/protocol";
import { CircleAlert } from "lucide-react";
import { modelErrorNote } from "@/lib/model-change";

/**
 * The strip under a session's header when Copilot CLI's latest model call failed (ADR-242), e.g. on a model the account
 * does not offer: the turn ends without an answer, and only Copilot CLI's own screen said why. The header's Model button
 * is the way to another model, so the strip only says what failed.
 */
export function ModelErrorNotice({ session }: { session: Session }) {
  const note = modelErrorNote(session);
  if (note === null) return null;
  return (
    <section aria-label="Model call failed" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <CircleAlert className="text-destructive size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium">{note.title}</span>
      <span className="text-muted-foreground min-w-0 break-words">{note.detail}</span>
    </section>
  );
}

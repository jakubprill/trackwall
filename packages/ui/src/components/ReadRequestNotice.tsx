import { agentsApi, type Session } from "@trackwall/protocol";
import { Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import { readRequestHold, shownReadRequest } from "@/lib/read-request";
import { useAction } from "@/lib/use-action";

/**
 * The strip under a running session's header while something waits unread for its agent (ADR-159): a review, a task
 * message or an update, the daemon's prompt about it, what holds it back, and Deliver now when the user can help it in.
 */
export function ReadRequestNotice({
  conn,
  session,
  onDelivered,
}: {
  conn: Connection;
  session: Session | undefined;
  onDelivered: () => void;
}) {
  const id = session?.id ?? "";
  const deliver = useAction(() => post(conn, agentsApi.deliverReadRequest, { session: id }), onDelivered);
  const request = shownReadRequest(session);
  if (!request) return null;
  const hold = readRequestHold(request);
  return (
    <section aria-label="Unread by the agent" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <Mail className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">Unread by the agent</span>
      <span className="text-muted-foreground shrink-0">{relativeTime(request.since, new Date())} ·</span>
      <span className="text-muted-foreground min-w-0 truncate" title={request.prompt}>
        {hold.text}
      </span>
      {deliver.error && <span className="text-destructive min-w-0 truncate">{deliver.error}</span>}
      {hold.canDeliver && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={deliver.run}
          disabled={deliver.pending}
          title={`Ask the agent now: ${request.prompt}`}
        >
          <Send /> Deliver now
        </Button>
      )}
    </section>
  );
}

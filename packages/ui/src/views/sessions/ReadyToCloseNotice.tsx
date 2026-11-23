import { agentsApi, readyToClose, type Session, type Task } from "@trackwall/protocol";
import { CheckCheck } from "lucide-react";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/**
 * The strip of a task whose agent said its work is over (ADR-282): "Close task" ends it with its branch kept, after
 * stopping its session, and "Keep open" leaves it in review. Close waits while the agent works again; a Close the daemon
 * refuses (work outside the branch) says why, and "End task" is where the user decides about that work.
 */
export function ReadyToCloseNotice({
  conn,
  task,
  session,
  onClosed,
  onKept,
}: {
  conn: Connection;
  task: Task;
  session: Session | undefined;
  onClosed: () => void;
  onKept: () => void;
}) {
  const close = useAction(() => post(conn, agentsApi.closeTask, { task: task.id }), onClosed);
  const keep = useAction(() => post(conn, agentsApi.keepTaskOpen, { task: task.id }), onKept);
  if (!task.readyToClose) return null;
  const idle = readyToClose(task, session);
  const pending = close.pending || keep.pending;
  const error = close.error ?? keep.error;
  return (
    <section aria-label="Ready to close" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5 text-xs">
      <CheckCheck className="text-primary size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">Ready to close</span>
      <span className="text-muted-foreground min-w-0">
        {idle
          ? "The agent says its work is over. Close ends the task and keeps its branch."
          : "The agent said its work is over, but it is working again; close the task once it stops."}
      </span>
      {error && <span className="text-destructive min-w-0 break-words">{error}</span>}
      <span className="ml-auto flex gap-2">
        <Button variant="outline" size="sm" onClick={close.run} disabled={pending || !idle}>
          <CheckCheck /> Close task
        </Button>
        <Button variant="ghost" size="sm" onClick={keep.run} disabled={pending}>
          Keep open
        </Button>
      </span>
      <Tip conn={conn} tip="ready-to-close" className="mb-1 basis-full" />
    </section>
  );
}

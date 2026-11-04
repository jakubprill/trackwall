import type { Session } from "@trackwall/protocol";
import { ConversationView } from "@/components/ConversationView";
import { SessionTerminal } from "@/components/SessionTerminal";
import type { Connection } from "@/lib/connection";
import { isLive } from "@/lib/session-state";
import type { TaskReview } from "@/lib/use-task-review";

/**
 * A session as it shows: its terminal (ADR-26), or the conversation view of a session over ACP (ADR-107), which takes
 * its task's review from the task panel.
 */
export function SessionScreen({
  conn,
  session,
  selected,
  review,
}: {
  conn: Connection;
  session: Session;
  selected: boolean;
  review?: TaskReview;
}) {
  if (session.view === "conversation")
    return <ConversationView key={session.id} conn={conn} session={session} selected={selected} review={review} />;
  return <SessionTerminal key={session.id} conn={conn} session={session.id} live={isLive(session)} selected={selected} />;
}

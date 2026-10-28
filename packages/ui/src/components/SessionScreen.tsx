import type { Session } from "@trackwall/protocol";
import { ConversationView } from "@/components/ConversationView";
import { SessionTerminal } from "@/components/SessionTerminal";
import type { Connection } from "@/lib/connection";
import { isLive } from "@/lib/session-state";

/** A session as it shows: its terminal (ADR-26), or the conversation view of a session over ACP (ADR-107). */
export function SessionScreen({ conn, session, selected }: { conn: Connection; session: Session; selected: boolean }) {
  if (session.view === "conversation") return <ConversationView key={session.id} conn={conn} session={session} selected={selected} />;
  return <SessionTerminal key={session.id} conn={conn} session={session.id} live={isLive(session)} selected={selected} />;
}

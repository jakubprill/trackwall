import type { Session } from "@trackwall/protocol";
import { Fragment } from "react";
import { CopyRequestNotice } from "@/components/CopyRequestNotice";
import { EnvironmentChangeNotice } from "@/components/EnvironmentChangeNotice";
import { ReadRequestNotice } from "@/components/ReadRequestNotice";
import type { Connection } from "@/lib/connection";

/**
 * The strips under a session's header, in the Sessions view, a task's panel and the supervisor panel: a changed environment
 * (ADR-119), something waiting unread for the agent (ADR-159) and a copy request (ADR-180). They mount again together with
 * the next session under one key of their own, so a strip's state, such as a failed restart, never stays next to another
 * session, and no strip shares a key with its neighbours, which made React keep stale copies of them.
 */
export function SessionNotices({ conn, session, onChanged }: { conn: Connection; session: Session | undefined; onChanged: () => void }) {
  return (
    <Fragment key={session?.id ?? "no-session"}>
      <EnvironmentChangeNotice conn={conn} session={session} onRestarted={onChanged} />
      <ReadRequestNotice conn={conn} session={session} onDelivered={onChanged} />
      {session && <CopyRequestNotice conn={conn} session={session} onCleared={onChanged} />}
    </Fragment>
  );
}

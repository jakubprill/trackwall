import type { Session } from "@trackwall/protocol";
import { StatusLabel } from "@/components/StatusLabel";
import { sessionStateLabel } from "@/lib/session-state";
import { useClock } from "@/lib/use-clock";
import { waitingLabel, waitingSinceTitle } from "@/lib/waiting-time";

/** A waiting time moves by the minute; half a minute keeps it at most that late. */
const CLOCK_MS = 30_000;

/**
 * A session's state, with how long it has waited for you after it (ADR-247), the same in every place that shows a
 * session's state: the Sessions list, a grid tile, the session and task headers, the dashboard and the tray panel.
 */
export function SessionStateLabel({ session, labelClassName }: { session: Session; labelClassName?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusLabel {...sessionStateLabel(session)} labelClassName={labelClassName} />
      {session.waitingSince !== null && <WaitingTime since={session.waitingSince} />}
    </span>
  );
}

function WaitingTime({ since }: { since: string }) {
  const now = useClock(CLOCK_MS);
  const label = waitingLabel(since, now);
  if (label === undefined) return null;
  return (
    <span className="text-warning shrink-0 font-mono whitespace-nowrap" title={waitingSinceTitle(since, now)}>
      <span aria-hidden>· </span>
      <span className="sr-only">waiting for </span>
      {label}
    </span>
  );
}

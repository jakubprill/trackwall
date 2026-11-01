import type { SessionList } from "@trackwall/protocol";
import { useEffect, useMemo, useState } from "react";
import { QueueItem } from "@/components/QueueItem";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { absenceToClose, awayHeadline, awaySummary } from "@/lib/away-summary";
import { relativeTime } from "@/lib/format";
import type { SessionSelection } from "@/lib/session-entries";
import { useAway } from "@/lib/use-away";

/** The strip counts minutes ("no step for 16 min", "5 min ago"), so it reads the clock again this often. */
const CLOCK_MS = 60_000;

/**
 * Strip above the views after an absence (ADR-151): what changed in the sessions while the user was away, folded to
 * one line until "Show"; an item opens its entry in Sessions (or the supervisor's panel). Nothing changed, nothing shown,
 * and the absence is closed.
 */
export function AwaySummary({ list, onOpen }: { list: SessionList | undefined; onOpen: (selection: SessionSelection) => void }) {
  const { away, dismiss } = useAway();
  const [expanded, setExpanded] = useState(false);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => setTicks((n) => n + 1), CLOCK_MS);
    return () => clearInterval(timer);
  }, [away]);
  // The clock is read in render, so a new absence never shows minutes counted from an older moment.
  const now = new Date();
  // `ticks` is the minute that passed, so the summary is computed again with the `now` read along with it.
  const items = useMemo(() => (list && away ? awaySummary(list, away, now) : []), [list, away, ticks]);
  const nothing = absenceToClose(list, away, items);
  useEffect(() => {
    if (nothing) dismiss();
  }, [nothing, dismiss]);
  if (!away || items.length === 0) return null;
  const done = () => {
    setExpanded(false);
    dismiss();
  };
  return (
    <section aria-label="While you were away" className="bg-primary/10 border-b px-4 py-2">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm">{awayHeadline(items, away)}</p>
        <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide" : "Show"}
        </Button>
        <Button variant="ghost" size="sm" onClick={done}>
          Dismiss
        </Button>
      </div>
      {expanded && (
        <ul className="mt-2 grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <QueueItem key={item.key} title={item.title} active={false} onClick={() => onOpen(item.open)}>
              <span className="flex flex-col gap-0.5">
                {item.facts.map((fact) => (
                  <StatusLabel key={fact.text} tone={fact.tone} label={fact.text} />
                ))}
                <span className="text-muted-foreground">{relativeTime(item.at, now)}</span>
              </span>
            </QueueItem>
          ))}
        </ul>
      )}
    </section>
  );
}

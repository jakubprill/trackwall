import type { SessionList } from "@trackwall/protocol";
import { useMemo, useState } from "react";
import { QueueItem } from "@/components/QueueItem";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { awayHeadline, awaySummary } from "@/lib/away-summary";
import { relativeTime } from "@/lib/format";
import type { SessionSelection } from "@/lib/session-entries";
import { useAway } from "@/lib/use-away";

/**
 * Strip above the views after an absence (ADR-151): what changed in the sessions while the user was away, folded to
 * one line until "Show"; an item opens its entry in Sessions (or the supervisor's panel). Nothing changed, nothing shown.
 */
export function AwaySummary({ list, onOpen }: { list: SessionList | undefined; onOpen: (selection: SessionSelection) => void }) {
  const { away, dismiss } = useAway();
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => (list && away ? awaySummary(list, away, new Date()) : []), [list, away]);
  if (!away || items.length === 0) return null;
  const done = () => {
    setExpanded(false);
    dismiss();
  };
  const now = new Date();
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

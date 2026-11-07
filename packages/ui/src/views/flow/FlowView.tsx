import { type BoardRevision, type SessionList, type TaskOutcome, trackwallLink } from "@trackwall/protocol";
import { useEffect, useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { ProgressBar } from "@/components/ProgressBar";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import {
  cardsIn,
  columnCounts,
  FLOW_COLUMN_LABELS,
  FLOW_COLUMNS,
  type FlowCard,
  type FlowColumn,
  type FlowGroup,
  flowGroups,
} from "@/lib/flow";
import { elapsedLabel } from "@/lib/format";
import { useOpenTrackwallLink } from "@/lib/trackwall-link";
import { useBoard } from "@/lib/use-board";
import { cn } from "@/lib/utils";

/** The cards' times are read again every half minute; the wall is looked at, not touched. */
const CLOCK_MS = 30_000;

/** A column's heading and counter take the colour of what it means; working and idle stay plain. */
const COLUMN_TEXT: Record<FlowColumn, string> = {
  working: "text-muted-foreground",
  waiting: "text-warning",
  review: "text-muted-foreground",
  stuck: "text-destructive",
  idle: "text-muted-foreground",
};

/**
 * Flow (ADR-224): every group of work in a row and every state in a column, read from across the room on a second
 * monitor. Nothing here changes anything: a card opens its task or session where sessions are shown, through the same
 * `trackwall://` link an agent would give (ADR-52), so in the desktop app the window that shows Sessions takes it and
 * this one keeps the wall (ADR-49). Ctrl+= makes everything larger for a far monitor (ADR-65).
 */
export function FlowView({
  conn,
  boardLive,
  sessions,
  sessionsError,
  onRetry,
  outcomes,
}: {
  conn: Connection;
  boardLive: LiveFeed<BoardRevision> | undefined;
  sessions: SessionList | undefined;
  sessionsError: string | undefined;
  onRetry: () => void;
  outcomes: ReadonlyMap<string, TaskOutcome>;
}) {
  const board = useBoard(conn, boardLive);
  const items = board.data?.items;
  const groups = useMemo(() => (sessions ? flowGroups({ list: sessions, items: items ?? [], outcomes }) : []), [sessions, items, outcomes]);
  const now = useClock();
  if (!sessions) {
    return (
      <div className="p-6">
        {sessionsError ? <ErrorWithRetry message={sessionsError} onRetry={onRetry} /> : <Loading text="Reading the tasks…" />}
      </div>
    );
  }
  const counts = columnCounts(groups);
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Flow</h2>
        {FLOW_COLUMNS.map((column) => (
          <span key={column} className="text-muted-foreground font-mono text-sm">
            <strong className={cn("mr-1 text-xl", counts[column] > 0 && COLUMN_TEXT[column])}>{counts[column]}</strong>
            {FLOW_COLUMN_LABELS[column].toLowerCase()}
          </span>
        ))}
        {board.error && <span className="text-muted-foreground text-xs">Without the plan: {board.error}</span>}
      </header>
      {groups.length === 0 ? (
        <p className="text-muted-foreground p-6">
          No tasks, sessions or proposals yet. Start one in Sessions or Plan, and it shows up here.
        </p>
      ) : (
        <FlowWall groups={groups} now={now} />
      )}
    </div>
  );
}

function FlowWall({ groups, now }: { groups: readonly FlowGroup[]; now: Date }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-5xl table-fixed border-collapse">
        <thead>
          <tr>
            <th scope="col" className="hud-label bg-card w-52 border-b px-3 py-2 text-left">
              Group
            </th>
            {FLOW_COLUMNS.map((column) => (
              <th key={column} scope="col" className={cn("hud-label bg-card border-b px-3 py-2 text-left", COLUMN_TEXT[column])}>
                {FLOW_COLUMN_LABELS[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.key} className="border-b align-top">
              <th scope="row" className="border-l-4 px-3 py-2 text-left font-normal">
                <span className="flex flex-col gap-1">
                  <span className="line-clamp-2 font-semibold break-words" title={group.name}>
                    {group.name}
                  </span>
                  <span className="text-muted-foreground text-xs">{group.summary}</span>
                  {group.progress && <ProgressBar progress={group.progress} className="mt-1" />}
                </span>
              </th>
              {FLOW_COLUMNS.map((column) => (
                <td key={column} className="border-l p-2">
                  <span className="flex min-w-0 flex-col gap-2">
                    {cardsIn(group, column).map((card) => (
                      <Card key={card.key} card={card} now={now} />
                    ))}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ card, now }: { card: FlowCard; now: Date }) {
  const open = useOpenTrackwallLink();
  const time = card.since ? elapsedLabel(card.since, now) : "";
  return (
    <button
      type="button"
      onClick={() => open(trackwallLink(card.target.kind, card.target.id))}
      title={`Open ${card.name}`}
      className={cn(
        "bg-card hover:bg-accent flex min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left",
        card.column === "stuck" && "border-destructive",
        card.column === "waiting" && "border-warning",
      )}
    >
      <span className="truncate text-sm font-semibold">{card.name}</span>
      <span className="text-muted-foreground truncate text-xs">{[card.repo, card.detail].filter(Boolean).join(" · ")}</span>
      {time && <span className={cn("font-mono text-xs", COLUMN_TEXT[card.column])}>{time}</span>}
    </button>
  );
}

/** The time now, read again every `CLOCK_MS`, so a card's time moves on while nothing else changes. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

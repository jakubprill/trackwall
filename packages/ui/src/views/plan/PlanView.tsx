import type { BoardRevision, SessionList } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { type PlanPlace, projectOf, startPrompt } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { ideaShortcutLabel } from "@/lib/idea-shortcut";
import { IS_MAC } from "@/lib/platform";
import type { SessionSelection } from "@/lib/session-entries";
import { useBoard } from "@/lib/use-board";
import { NewSession } from "@/views/sessions/NewSession";
import { ItemPanel } from "./ItemPanel.tsx";
import { PlanOutline } from "./PlanOutline.tsx";
import { PlanPlaces } from "./PlanPlaces.tsx";

/**
 * The Plan view (ADR-133): the inbox of ideas and the business projects on the left, the selected one's items as an
 * outline in the middle, where the user splits the work, and the selected item on the right, with the tasks started on
 * it and "Start task". Nothing here starts work by itself.
 */
export function PlanView({
  conn,
  boardLive,
  sessions,
  onOpenInSessions,
}: {
  conn: Connection;
  boardLive: LiveFeed<BoardRevision> | undefined;
  sessions: SessionList | undefined;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const board = useBoard(conn, boardLive);
  const [place, setPlace] = useState<PlanPlace>({ kind: "inbox" });
  const [selected, setSelected] = useState<string>();
  const [starting, setStarting] = useState<string>();
  const items = board.data?.items ?? [];
  const item = items.find((it) => it.id === selected);
  const startingItem = items.find((it) => it.id === starting);
  const choosePlace = (next: PlanPlace) => {
    setPlace(next);
    setSelected(undefined);
    setStarting(undefined);
  };
  // An item opened from elsewhere in the tree (a new idea filed under a project) shows its project.
  const select = (id: string | undefined) => {
    setSelected(id);
    const it = items.find((candidate) => candidate.id === id);
    const project = it && projectOf(items, it);
    if (project && (place.kind !== "project" || place.id !== project.id)) setPlace({ kind: "project", id: project.id });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[14rem_1fr_24rem]">
      <aside className="flex min-h-0 flex-col border-r">
        <header className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">Plan</h2>
          <Button variant="ghost" size="icon" onClick={board.reload} aria-label="Refresh the plan">
            <RefreshCw />
          </Button>
        </header>
        {board.data && <PlanPlaces conn={conn} items={items} place={place} onPlace={choosePlace} onChanged={board.reload} />}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
        {board.error && <ErrorWithRetry message={board.error} onRetry={board.reload} />}
        {!board.data && !board.error && (
          <div className="p-6">
            <Loading text="Reading the board…" />
          </div>
        )}
        {board.data && board.data.problems.length > 0 && (
          <ul className="text-warning flex flex-col gap-1 px-4 pt-3 text-xs">
            {board.data.problems.map((p) => (
              <li key={p.file} className="break-words">
                <span className="font-mono">{p.file}</span>: {p.message}
              </li>
            ))}
          </ul>
        )}
        {startingItem ? (
          <NewSession
            key={startingItem.id}
            conn={conn}
            sessions={sessions?.sessions ?? []}
            fromItem={{
              item: startingItem.id,
              repos: startingItem.repos,
              prompt: startPrompt(items, startingItem),
            }}
            onStarted={(selection) => {
              setStarting(undefined);
              onOpenInSessions(selection);
            }}
            onCancel={() => setStarting(undefined)}
          />
        ) : (
          board.data && (
            <PlanOutline
              conn={conn}
              items={items}
              tasks={sessions?.tasks ?? []}
              place={place}
              selected={selected}
              onSelect={select}
              onChanged={board.reload}
            />
          )
        )}
        <p className="text-muted-foreground mt-auto px-4 py-3 text-xs">
          {ideaShortcutLabel(IS_MAC)} writes an idea into the inbox from any view.
        </p>
      </section>
      <aside className="min-h-0 overflow-y-auto border-l">
        {item ? (
          <ItemPanel
            key={item.id}
            conn={conn}
            items={items}
            item={item}
            tasks={(sessions?.tasks ?? []).filter((t) => t.item === item.id)}
            onStartTask={() => setStarting(item.id)}
            onOpenTask={(task) => onOpenInSessions({ kind: "task", id: task })}
            onRemoved={() => setSelected(undefined)}
            onChanged={board.reload}
          />
        ) : (
          <p className="text-muted-foreground p-4 text-sm">Select an item to see its plan and start a task on it.</p>
        )}
      </aside>
    </div>
  );
}

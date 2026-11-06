import type { BoardItem, BoardRevision, SessionList, Task, TaskOutcome } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { type PlanPlace, placeOfSelected, startPrompt } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { ideaShortcutLabel } from "@/lib/idea-shortcut";
import { type InboxFilter, ideaAfter, shownIdeas } from "@/lib/inbox-triage";
import { type ItemTaskIndex, itemTaskIndex } from "@/lib/plan-progress";
import { IS_MAC } from "@/lib/platform";
import type { SessionSelection } from "@/lib/session-entries";
import { useBoard } from "@/lib/use-board";
import { useKnowledge } from "@/lib/use-knowledge";
import { NewSession } from "@/views/sessions/NewSession";
import { InboxTriage } from "./InboxTriage.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { KnowledgeList } from "./KnowledgeList.tsx";
import { KnowledgePanel } from "./KnowledgePanel.tsx";
import { PlanOutline } from "./PlanOutline.tsx";
import { PlanPlaces } from "./PlanPlaces.tsx";

/**
 * The Plan view (ADR-133): the inbox of ideas and the business projects on the left, the inbox's ideas to sort (ADR-214)
 * or the selected project's items as an outline in the middle, where the user splits the work, and the selected item on the right, with the tasks started on
 * it and "Start task". Nothing here starts work by itself. The workspace knowledge (ADR-170) takes the middle when chosen
 * on the left.
 */
export function PlanView({
  conn,
  boardLive,
  sessions,
  outcomes,
  onOpenInSessions,
}: {
  conn: Connection;
  boardLive: LiveFeed<BoardRevision> | undefined;
  sessions: SessionList | undefined;
  /** Every task's outcome by task (ADR-154), for the state of an item's tasks. */
  outcomes: ReadonlyMap<string, TaskOutcome>;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const board = useBoard(conn, boardLive);
  const [place, setPlace] = useState<PlanPlace>({ kind: "inbox" });
  const [selected, setSelected] = useState<string>();
  const [starting, setStarting] = useState<string>();
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const { knowledge, entries, entry, select: selectEntry } = useKnowledge(conn, place.kind === "knowledge");
  const tasks = sessions?.tasks ?? [];
  const items = board.data?.items ?? [];
  const taskIndex = useMemo(
    () => itemTaskIndex({ tasks: sessions?.tasks ?? [], sessions: sessions?.sessions ?? [], outcomes }),
    [sessions, outcomes],
  );
  // The inbox opens on its newest idea, so sorting starts without a click and the right column is never empty there.
  const firstIdea = place.kind === "inbox" ? shownIdeas(items, inboxFilter)[0] : undefined;
  const shown = selected ?? firstIdea?.id;
  const item = place.kind === "knowledge" ? undefined : items.find((it) => it.id === shown);
  const startingItem = items.find((it) => it.id === starting);
  const choosePlace = (next: PlanPlace) => {
    setPlace(next);
    setSelected(undefined);
    setStarting(undefined);
  };
  const select = (id: string | undefined) => {
    setSelected(id);
    const next = placeOfSelected(items, place, id);
    if (next) setPlace(next);
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
        {board.data && (
          <PlanPlaces
            conn={conn}
            items={items}
            knowledge={entries}
            taskIndex={taskIndex}
            place={place}
            onPlace={choosePlace}
            onChanged={board.reload}
          />
        )}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
        <BoardState board={board} />
        {place.kind === "knowledge" ? (
          <KnowledgeList conn={conn} knowledge={knowledge} tasks={tasks} selected={entry?.name} onSelect={selectEntry} />
        ) : startingItem ? (
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
            <PlaceItems
              conn={conn}
              items={items}
              tasks={tasks}
              taskIndex={taskIndex}
              place={place}
              inboxFilter={inboxFilter}
              onInboxFilter={(filter) => {
                setInboxFilter(filter);
                setSelected(undefined);
              }}
              selected={shown}
              onSelect={setSelected}
              onSelectInTree={select}
              onStartTask={setStarting}
              onChanged={board.reload}
            />
          )
        )}
        <p className="text-muted-foreground mt-auto px-4 py-3 text-xs">
          {ideaShortcutLabel(IS_MAC)} writes an idea into the inbox from any view.
        </p>
      </section>
      <aside className="min-h-0 overflow-y-auto border-l">
        {entry ? (
          <KnowledgePanel
            key={`${entry.name}-${entry.digest}`}
            conn={conn}
            entry={entry}
            tasks={tasks}
            onChanged={knowledge.reload}
            onRemoved={() => {
              selectEntry(undefined);
              knowledge.reload();
            }}
          />
        ) : item ? (
          <ItemPanel
            key={item.id}
            conn={conn}
            items={items}
            item={item}
            taskIndex={taskIndex}
            onStartTask={() => setStarting(item.id)}
            onOpenTask={(task) => onOpenInSessions({ kind: "task", id: task })}
            onRemoved={() => setSelected(undefined)}
            onFiled={() => setSelected(ideaAfter(shownIdeas(items, inboxFilter), item.id))}
            onChanged={board.reload}
          />
        ) : (
          <NothingSelected place={place} />
        )}
      </aside>
    </div>
  );
}

function NothingSelected({ place }: { place: PlanPlace }) {
  return (
    <p className="text-muted-foreground p-4 text-sm">
      {place.kind === "knowledge"
        ? "Select an entry to read its evidence and approve it."
        : "Select an item to see its plan and start a task on it."}
    </p>
  );
}

/** Reading the board, why it failed, and the files of it the daemon could not read. */
function BoardState({ board }: { board: ReturnType<typeof useBoard> }) {
  if (board.error) return <ErrorWithRetry message={board.error} onRetry={board.reload} />;
  if (!board.data) {
    return (
      <div className="p-6">
        <Loading text="Reading the board…" />
      </div>
    );
  }
  if (board.data.problems.length === 0) return null;
  return (
    <ul className="text-warning flex flex-col gap-1 px-4 pt-3 text-xs">
      {board.data.problems.map((p) => (
        <li key={p.file} className="break-words">
          <span className="font-mono">{p.file}</span>: {p.message}
        </li>
      ))}
    </ul>
  );
}

/** The items of the place chosen on the left: the inbox's ideas to sort, or a project's outline. */
function PlaceItems({
  conn,
  items,
  tasks,
  taskIndex,
  place,
  inboxFilter,
  onInboxFilter,
  selected,
  onSelect,
  onSelectInTree,
  onStartTask,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  tasks: readonly Task[];
  taskIndex: ItemTaskIndex;
  place: PlanPlace;
  inboxFilter: InboxFilter;
  onInboxFilter: (filter: InboxFilter) => void;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Selects an item and shows the project it lies in. */
  onSelectInTree: (id: string | undefined) => void;
  onStartTask: (id: string) => void;
  onChanged: () => void;
}) {
  if (place.kind === "inbox") {
    return (
      <InboxTriage
        conn={conn}
        items={items}
        tasks={tasks}
        filter={inboxFilter}
        onFilter={onInboxFilter}
        selected={selected}
        onSelect={onSelect}
        onStartTask={onStartTask}
        onChanged={onChanged}
      />
    );
  }
  const project = place.kind === "project" ? items.find((it) => it.id === place.id) : undefined;
  if (!project) return <p className="text-muted-foreground p-4 text-sm">This project is gone.</p>;
  return (
    <PlanOutline
      conn={conn}
      items={items}
      taskIndex={taskIndex}
      project={project}
      selected={selected}
      onSelect={onSelectInTree}
      onChanged={onChanged}
    />
  );
}

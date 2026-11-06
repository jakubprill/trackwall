import { type BoardItem, boardApi, childrenOf, countLabel } from "@trackwall/protocol";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { COLUMN_LABELS, type ItemMove, isClosed, type OutlineRow, outline, rowKeyMove } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import {
  hiddenAsDone,
  type ItemTask,
  type ItemTaskIndex,
  itemTasks,
  PROGRESS_COLUMNS,
  type Progress,
  progressBelow,
  progressLabel,
  tasksWaiting,
} from "@/lib/plan-progress";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";
import { NewItemLine } from "./NewItemLine.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { ProjectBoard } from "./ProjectBoard.tsx";
import { RowTask } from "./RowTask.tsx";
import { TicketLink } from "./TicketLink.tsx";

/**
 * The middle of Plan for a project: how far it is (ADR-215), and its items as an outline, each with its repos, the state
 * of the tasks started on it and, above other items, how many of those are done. On a focused row Tab puts the item under the one above it
 * and Shift+Tab takes it out a level, Alt+↑ and Alt+↓ move it among its siblings; the line at the bottom adds an item at
 * the top level of the project. The inbox has a view of its own (`InboxTriage`).
 */
export function PlanOutline({
  conn,
  items,
  taskIndex,
  project,
  selected,
  onSelect,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  taskIndex: ItemTaskIndex;
  project: BoardItem;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  onChanged: () => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);
  const [layout, setLayout] = useState<ProjectLayout>("outline");
  const move = useAction((id: string, to: ItemMove) => post(conn, boardApi.move, { item: id, ...to }), onChanged);
  // Counted once per board change, not on every render of every row.
  const progress = useMemo(
    () => new Map([project.id, ...outline(items, project.id).map((row) => row.item.id)].map((id) => [id, progressBelow(items, id)])),
    [items, project.id],
  );
  const progressOf = (id: string) => progress.get(id) ?? progressBelow(items, id);
  const rows = outline(items, project.id, folded).filter((row) => !hideDone || !hiddenAsDone(items, row.item));
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <ProjectHeader conn={conn} project={project} layout={layout} onLayout={setLayout} onChanged={onChanged} />
      <ProjectProgress
        progress={progressOf(project.id)}
        waiting={tasksWaiting(items, project.id, taskIndex)}
        hideDone={hideDone}
        onHideDone={setHideDone}
      />
      {layout === "board" ? (
        <ProjectBoard
          conn={conn}
          items={items}
          project={project.id}
          taskIndex={taskIndex}
          hideDone={hideDone}
          selected={selected}
          onSelect={onSelect}
          onChanged={onChanged}
        />
      ) : (
        <>
          {move.error && <p className="text-destructive text-sm">{move.error}</p>}
          <ul className="flex flex-col">
            {rows.map((row) => (
              <Row
                key={row.item.id}
                row={row}
                hasChildren={childrenOf(items, row.item.id).length > 0}
                progress={progressOf(row.item.id)}
                tasks={itemTasks(row.item.id, taskIndex)}
                folded={folded.has(row.item.id)}
                selected={row.item.id === selected}
                onToggle={() => toggle(row.item.id)}
                onSelect={() => onSelect(row.item.id)}
                onKeyMove={(press) => {
                  const to = rowKeyMove(press, items, row.item);
                  if (to) move.run(row.item.id, to);
                  return to !== undefined;
                }}
              />
            ))}
          </ul>
        </>
      )}
      <NewItemLine
        conn={conn}
        parent={project.id}
        label="New item in this project"
        onAdded={(id) => {
          onChanged();
          onSelect(id);
        }}
      />
      {layout === "outline" && rows.length > 0 && (
        <p className="text-muted-foreground text-xs">
          On a selected row: Tab puts it under the one above, Shift+Tab takes it out, Alt+↑ and Alt+↓ move it.
        </p>
      )}
    </div>
  );
}

/** How the middle shows a project: the tree to split the work, or the board of its items not split further (ADR-217). */
type ProjectLayout = "outline" | "board";

const LAYOUTS: readonly { layout: ProjectLayout; label: string }[] = [
  { layout: "outline", label: "Outline" },
  { layout: "board", label: "Board" },
];

function ProjectHeader({
  conn,
  project,
  layout,
  onLayout,
  onChanged,
}: {
  conn: Connection;
  project: BoardItem;
  layout: ProjectLayout;
  onLayout: (layout: ProjectLayout) => void;
  onChanged: () => void;
}) {
  const archived = isClosed(project);
  const archive = useAction(() => post(conn, boardApi.update, { item: project.id, column: archived ? "ready" : "done" }), onChanged);
  return (
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-medium">{project.title}</h2>
      <TicketLink conn={conn} link={project.link} />
      <span className="flex-1" />
      <fieldset aria-label="Show the project as" className="flex rounded-md border">
        {LAYOUTS.map((option) => (
          <Button
            key={option.layout}
            variant={option.layout === layout ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={option.layout === layout}
            onClick={() => onLayout(option.layout)}
          >
            {option.label}
          </Button>
        ))}
      </fieldset>
      <Button variant="ghost" size="sm" disabled={archive.pending} onClick={() => archive.run()}>
        {archived ? "Restore project" : "Archive project"}
      </Button>
      {archive.error && <p className="text-destructive text-sm">{archive.error}</p>}
    </header>
  );
}

/** "2 of 9 done", the bar, the count of each column, the tasks waiting for the user and "Hide done". */
function ProjectProgress({
  progress,
  waiting,
  hideDone,
  onHideDone,
}: {
  progress: Progress;
  waiting: number;
  hideDone: boolean;
  onHideDone: (hide: boolean) => void;
}) {
  const label = progressLabel(progress);
  if (label === undefined) return null;
  return (
    <section aria-label="Progress" className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-sm">
      <span className="font-medium">{label}</span>
      <ProgressBar progress={progress} className="w-48" />
      <span className="text-muted-foreground text-xs">
        {PROGRESS_COLUMNS.filter((column) => progress.byColumn[column] > 0)
          .map((column) => `${COLUMN_LABELS[column]} ${progress.byColumn[column]}`)
          .join(" · ")}
      </span>
      <span className="flex-1" />
      {waiting > 0 && (
        <span className="text-xs">
          <StatusLabel tone="warning" label={`${countLabel(waiting, { one: "task waits", other: "tasks wait" })} for you`} />
        </span>
      )}
      <Button variant="ghost" size="sm" aria-pressed={hideDone} onClick={() => onHideDone(!hideDone)}>
        {hideDone ? "Show done" : "Hide done"}
      </Button>
    </section>
  );
}

function Row({
  row: { item, depth },
  hasChildren,
  progress,
  tasks,
  folded,
  selected,
  onToggle,
  onSelect,
  onKeyMove,
}: {
  row: OutlineRow;
  hasChildren: boolean;
  /** The items below it, shown as "1/4" on an item that has any. */
  progress: Progress;
  /** The tasks started on it, newest first; the newest one's state shows on the row. */
  tasks: readonly ItemTask[];
  folded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  /** Whether the key moved the item; only then is it taken, so Tab on the first row still moves the keyboard on. */
  onKeyMove: (press: KeyboardEvent) => boolean;
}) {
  const closed = item.column === "done" || item.column === "dropped";
  return (
    <li className="flex items-center gap-1" style={{ paddingLeft: `${depth * 1.25}rem` }}>
      <button
        type="button"
        aria-label={folded ? "Unfold" : "Fold"}
        className={cn("text-muted-foreground size-5 shrink-0", !hasChildren && "invisible")}
        onClick={onToggle}
      >
        {folded ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      <button
        type="button"
        onClick={onSelect}
        onKeyDown={(e) => {
          if (onKeyMove(e.nativeEvent)) e.preventDefault();
        }}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "hover:bg-accent flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left text-sm",
          selected && "bg-accent text-accent-foreground",
          closed && "text-muted-foreground line-through",
        )}
      >
        <span className="min-w-0 truncate">{item.title}</span>
        {item.createdBy.kind === "agent" && <Bot aria-label="Written by an agent" className="text-muted-foreground size-3.5 shrink-0" />}
        {hasChildren && progress.total > 0 && (
          <span className="text-muted-foreground font-mono text-xs" title={progressLabel(progress)}>
            {progress.done}/{progress.total}
          </span>
        )}
        <span className="flex-1" />
        {item.repos.map((repo) => (
          <Badge key={repo} variant="outline" className="text-muted-foreground font-mono">
            {repo}
          </Badge>
        ))}
        <RowTask tasks={tasks} />
        <Badge variant="outline" className="w-24 justify-center">
          {COLUMN_LABELS[item.column]}
        </Badge>
      </button>
    </li>
  );
}

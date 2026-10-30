import { type BoardItem, boardApi, childrenOf, countLabel, type Task } from "@trackwall/protocol";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import {
  COLUMN_LABELS,
  type ItemMove,
  ideaFields,
  isArchived,
  type OutlineRow,
  outline,
  type PlanPlace,
  rowKeyMove,
} from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

/**
 * The middle of Plan: the inbox's ideas, or a project's items as an outline. On a focused row Tab puts the item under the
 * one above it and Shift+Tab takes it out a level, Alt+↑ and Alt+↓ move it among its siblings; the line at the bottom
 * adds an item at the top level of the project, or an idea.
 */
export function PlanOutline({
  conn,
  items,
  tasks,
  place,
  selected,
  onSelect,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  tasks: readonly Task[];
  place: PlanPlace;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  onChanged: () => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const project = place.kind === "project" ? items.find((it) => it.id === place.id) : undefined;
  const move = useAction((id: string, to: ItemMove) => post(conn, boardApi.move, { item: id, ...to }), onChanged);
  if (place.kind === "project" && !project) return <p className="text-muted-foreground p-4 text-sm">This project is gone.</p>;
  const rows = project ? outline(items, project.id, folded) : childrenOf(items, null).map((item) => ({ item, depth: 0 }));
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      {project ? <ProjectHeader conn={conn} project={project} onChanged={onChanged} /> : <h2 className="text-lg font-medium">Inbox</h2>}
      {!project && rows.length === 0 && (
        <p className="text-muted-foreground text-sm">No ideas waiting. Write one below, or ask an agent to note something for later.</p>
      )}
      {move.error && <p className="text-destructive text-sm">{move.error}</p>}
      <ul className="flex flex-col">
        {rows.map((row) => (
          <Row
            key={row.item.id}
            row={row}
            hasChildren={childrenOf(items, row.item.id).length > 0}
            tasks={tasks.filter((t) => t.item === row.item.id).length}
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
      <NewItemLine
        conn={conn}
        parent={project?.id ?? null}
        onAdded={(id) => {
          onChanged();
          onSelect(id);
        }}
      />
      {project && rows.length > 0 && (
        <p className="text-muted-foreground text-xs">
          On a selected row: Tab puts it under the one above, Shift+Tab takes it out, Alt+↑ and Alt+↓ move it.
        </p>
      )}
    </div>
  );
}

function ProjectHeader({ conn, project, onChanged }: { conn: Connection; project: BoardItem; onChanged: () => void }) {
  const archived = isArchived(project);
  const archive = useAction(() => post(conn, boardApi.update, { item: project.id, column: archived ? "ready" : "done" }), onChanged);
  return (
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-medium">{project.title}</h2>
      <Button variant="ghost" size="sm" disabled={archive.pending} onClick={() => archive.run()}>
        {archived ? "Restore project" : "Archive project"}
      </Button>
      {archive.error && <p className="text-destructive text-sm">{archive.error}</p>}
    </header>
  );
}

function Row({
  row: { item, depth },
  hasChildren,
  tasks,
  folded,
  selected,
  onToggle,
  onSelect,
  onKeyMove,
}: {
  row: OutlineRow;
  hasChildren: boolean;
  tasks: number;
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
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.createdBy.kind === "agent" && <Bot aria-label="Written by an agent" className="text-muted-foreground size-3.5" />}
        {tasks > 0 && <Badge variant="secondary">{countLabel(tasks, { one: "task", other: "tasks" })}</Badge>}
        <Badge variant="outline">{COLUMN_LABELS[item.column]}</Badge>
      </button>
    </li>
  );
}

/** The line that adds an item under `parent`: a project's top level, or with `null` an idea in the inbox. */
function NewItemLine({ conn, parent, onAdded }: { conn: Connection; parent: string | null; onAdded: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const add = useAction(
    (fields: { title: string; body: string }) => post(conn, boardApi.create, { kind: "item", parent, ...fields }),
    (item) => {
      setTitle("");
      onAdded(item.id);
    },
  );
  const fields = ideaFields(title);
  const label = parent === null ? "New idea" : "New item in this project";
  return (
    <>
      <Input
        aria-label={label}
        placeholder={label}
        value={title}
        disabled={add.pending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && fields) add.run(fields);
        }}
      />
      {add.error && <p className="text-destructive text-sm">{add.error}</p>}
    </>
  );
}

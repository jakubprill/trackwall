import { BoardColumn, type BoardItem, type BoardItemChange, boardApi, childrenOf, workspaceApi } from "@trackwall/protocol";
import { Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { COLUMN_LABELS, ideaFields, isClosed, projectOf, projectsOf } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { filingChoices, isOpenIdea } from "@/lib/inbox-triage";
import { type ItemTaskIndex, itemTasks, progressBelow, progressLabel, tasksBelow } from "@/lib/plan-progress";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { FilingChoices } from "./FilingChoices.tsx";
import { ItemTasks } from "./ItemTasks.tsx";
import { ItemText } from "./ItemText.tsx";

/**
 * The selected item of Plan: its text to read and edit (ADR-215), its column and repos, where it is filed, the items it
 * is split into with a line to split it further, and the tasks started on it with their state and "Start task", which
 * opens the task form with the item's repo and prompt (ADR-133). Who wrote it shows, since an agent may have written it.
 */
export function ItemPanel({
  conn,
  items,
  item,
  taskIndex,
  onStartTask,
  onOpenTask,
  onRemoved,
  onFiled,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  item: BoardItem;
  /** The tasks of each item with their state. */
  taskIndex: ItemTaskIndex;
  onStartTask: () => void;
  onOpenTask: (task: string) => void;
  onRemoved: () => void;
  /** An idea of the inbox was filed in a project, so it left the inbox. */
  onFiled: () => void;
  onChanged: () => void;
}) {
  const isProject = item.kind === "project";
  const isIdea = isOpenIdea(item);
  const update = useAction((change: BoardItemChange) => post(conn, boardApi.update, { item: item.id, ...change }), onChanged);
  const move = useAction(
    (parent: string | null) => post(conn, boardApi.move, { item: item.id, parent, before: null }),
    () => {
      if (isIdea) onFiled();
      onChanged();
    },
  );
  const error = update.error ?? move.error;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="hud-label">
        {isProject ? "Project" : item.parent === null ? "Idea" : "Item"}
        {item.createdBy.kind === "agent" && <span className="text-muted-foreground normal-case"> · written by an agent</span>}
      </p>
      <ItemText conn={conn} items={items} item={item} onChanged={onChanged} />
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground w-16">Column</span>
        <select
          value={item.column}
          onChange={(e) => update.run({ column: BoardColumn.parse(e.target.value) })}
          className="border-input bg-card h-8 rounded-md border px-2 text-sm"
        >
          {BoardColumn.options.map((column) => (
            <option key={column} value={column}>
              {COLUMN_LABELS[column]}
            </option>
          ))}
        </select>
      </label>
      {isIdea && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-sm">File in a project</span>
          <FilingChoices choices={filingChoices(items, item)} numbered={false} disabled={move.pending} onFile={move.run} />
        </div>
      )}
      {!isProject && item.parent !== null && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground w-16">Filed in</span>
          <select
            value={item.parent === null ? "" : (projectOf(items, item)?.id ?? "")}
            onChange={(e) => move.run(e.target.value === "" ? null : e.target.value)}
            className="border-input bg-card h-8 min-w-0 flex-1 rounded-md border px-2 text-sm"
          >
            <option value="">Inbox</option>
            {projectsOf(items).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {!isProject && <ItemRepos conn={conn} repos={item.repos} onChange={(repos) => update.run({ repos })} />}
      <ItemSplit items={items} item={item} />
      <SplitLine conn={conn} item={item} onChanged={onChanged} />
      {!isProject && (
        <ItemTasks
          tasks={itemTasks(item.id, taskIndex)}
          below={tasksBelow(items, item.id, taskIndex)}
          onStartTask={onStartTask}
          onOpenTask={onOpenTask}
        />
      )}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
      <RemoveItem conn={conn} item={item} onRemoved={onRemoved} onChanged={onChanged} />
    </div>
  );
}

/** The repos an item is about, removed with ×, added from the repos of the projects folder. */
function ItemRepos({ conn, repos, onChange }: { conn: Connection; repos: readonly string[]; onChange: (repos: string[]) => void }) {
  const load = useCallback(() => post(conn, workspaceApi.list, {}), [conn]);
  const listed = useRemote(load).data?.repos ?? [];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-sm">Repos</span>
      <div className="flex flex-wrap items-center gap-1">
        {repos.map((repo) => (
          <Badge key={repo} variant="secondary">
            {repo}
            <button type="button" aria-label={`Remove ${repo}`} onClick={() => onChange(repos.filter((r) => r !== repo))}>
              <X />
            </button>
          </Badge>
        ))}
        <select
          aria-label="Add a repo"
          value=""
          onChange={(e) => onChange([...repos, e.target.value])}
          className="border-input bg-card h-7 rounded-md border px-1 text-xs"
        >
          <option value="">Add a repo…</option>
          {listed
            .filter((r) => !repos.includes(r.id))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

/** The items right under this one with their columns, under "Split · 1 of 4 done"; nothing for an item not split yet. */
function ItemSplit({ items, item }: { items: readonly BoardItem[]; item: BoardItem }) {
  const children = childrenOf(items, item.id);
  if (children.length === 0) return null;
  return (
    <section aria-label="Split" className="flex flex-col gap-1">
      <h4 className="hud-label">Split · {progressLabel(progressBelow(items, item.id)) ?? "all dropped"}</h4>
      <ul className="flex flex-col gap-0.5 text-sm">
        {children.map((child) => (
          <li key={child.id} className="flex items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate", isClosed(child) && "text-muted-foreground line-through")}>{child.title}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{COLUMN_LABELS[child.column]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A line that splits the item: what is typed becomes an item under it (under a project, an item at its top level). */
function SplitLine({ conn, item, onChanged }: { conn: Connection; item: BoardItem; onChanged: () => void }) {
  const [text, setText] = useState("");
  const add = useAction(
    (fields: { title: string; body: string }) => post(conn, boardApi.create, { kind: "item", parent: item.id, ...fields }),
    () => {
      setText("");
      onChanged();
    },
  );
  const fields = ideaFields(text);
  const label = item.kind === "project" ? "New item in this project" : "Split: a new item under this one";
  return (
    <>
      <Input
        aria-label={label}
        placeholder={label}
        value={text}
        disabled={add.pending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && fields) add.run(fields);
        }}
      />
      {add.error && <p className="text-destructive text-sm">{add.error}</p>}
    </>
  );
}

/** "Remove", then "Remove for good" or "Keep it": the item's file is deleted, and nothing keeps a copy. */
function RemoveItem({
  conn,
  item,
  onRemoved,
  onChanged,
}: {
  conn: Connection;
  item: BoardItem;
  onRemoved: () => void;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const remove = useAction(
    () => post(conn, boardApi.remove, { item: item.id }),
    () => {
      onRemoved();
      onChanged();
    },
  );
  return (
    <div className="flex flex-col gap-1 pt-2">
      <div className="flex items-center gap-2">
        {asking ? (
          <>
            <Button variant="destructive" size="sm" disabled={remove.pending} onClick={() => remove.run()}>
              Remove for good
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      {remove.error && <p className="text-destructive text-sm">{remove.error}</p>}
    </div>
  );
}

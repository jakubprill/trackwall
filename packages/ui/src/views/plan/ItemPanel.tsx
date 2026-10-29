import { BoardColumn, type BoardItem, type BoardItemChange, boardApi, type Task, workspaceApi } from "@trackwall/protocol";
import { ExternalLink, GitBranch, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { COLUMN_LABELS, ideaFields, projectOf, projectsOf } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The selected item of Plan: its text to edit, its column, repos and ticket link, where it is filed, a line to split it,
 * and the tasks started on it with "Start task", which opens the task form with the item's repo and prompt (ADR-133).
 * Who wrote it shows, since an agent may have written it while working.
 */
export function ItemPanel({
  conn,
  items,
  item,
  tasks,
  onStartTask,
  onOpenTask,
  onRemoved,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  item: BoardItem;
  /** The tasks started on this item. */
  tasks: readonly Task[];
  onStartTask: () => void;
  onOpenTask: (task: string) => void;
  onRemoved: () => void;
  onChanged: () => void;
}) {
  const update = useAction((change: BoardItemChange) => post(conn, boardApi.update, { item: item.id, ...change }), onChanged);
  const move = useAction((parent: string | null) => post(conn, boardApi.move, { item: item.id, parent, before: null }), onChanged);
  const isProject = item.kind === "project";
  const error = update.error ?? move.error;
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="hud-label">
        {isProject ? "Project" : item.parent === null ? "Idea" : "Item"}
        {item.createdBy.kind === "agent" && <span className="text-muted-foreground normal-case"> · written by an agent</span>}
      </p>
      <ItemText conn={conn} item={item} pending={update.pending} onSave={update.run} />
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
      {!isProject && (
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
      <SplitLine conn={conn} item={item} onChanged={onChanged} />
      {!isProject && <ItemTasks tasks={tasks} onStartTask={onStartTask} onOpenTask={onOpenTask} />}
      {error && <p className="text-destructive text-sm whitespace-pre-wrap">{error}</p>}
      <RemoveItem conn={conn} item={item} onRemoved={onRemoved} onChanged={onChanged} />
    </div>
  );
}

/** Title, body and link, saved together with "Save" once one of them differs from the item. */
function ItemText({
  conn,
  item,
  pending,
  onSave,
}: {
  conn: Connection;
  item: BoardItem;
  pending: boolean;
  onSave: (change: BoardItemChange) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [link, setLink] = useState(item.link ?? "");
  const openLink = useOpenWebLink(conn);
  const edited = title.trim() !== item.title || body !== item.body || link.trim() !== (item.link ?? "");
  return (
    <>
      <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea
        aria-label="Plan and notes"
        placeholder="The plan, notes, what done means (Markdown)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
      />
      <div className="flex items-center gap-1">
        <Input
          aria-label="Link to the ticket"
          placeholder="Link to the ticket, e.g. https://…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        {item.link && (
          <Button variant="ghost" size="icon" aria-label="Open the ticket" onClick={() => void openLink(item.link ?? "")}>
            <ExternalLink />
          </Button>
        )}
      </div>
      {edited && (
        <Button
          className="w-fit"
          disabled={pending || title.trim() === ""}
          onClick={() => onSave({ title: title.trim(), body, link: link.trim() === "" ? null : link.trim() })}
        >
          Save
        </Button>
      )}
    </>
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

function ItemTasks({
  tasks,
  onStartTask,
  onOpenTask,
}: {
  tasks: readonly Task[];
  onStartTask: () => void;
  onOpenTask: (task: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-sm">Tasks</span>
      {tasks.length === 0 && <p className="text-muted-foreground text-xs">No task started on it yet.</p>}
      <ul className="flex flex-col">
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => onOpenTask(task.id)}
              className="hover:bg-accent w-full truncate rounded-sm px-1 py-0.5 text-left text-sm"
            >
              <span className="font-mono text-xs">{task.repo}</span> {task.title ?? task.prompt.split("\n")[0]}
            </button>
          </li>
        ))}
      </ul>
      <Button className="w-fit" onClick={onStartTask}>
        <GitBranch /> Start task
      </Button>
    </div>
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

import { type BoardItem, boardApi, countLabel, type Task } from "@trackwall/protocol";
import { Bot, ChevronDown, ChevronRight, FolderInput, GitBranch, Undo2, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { relativeTime } from "@/lib/format";
import {
  filingChoices,
  IDEA_AGE_LABELS,
  INBOX_FILTERS,
  type InboxFilter,
  ideaAfter,
  ideaAuthor,
  ideaGroups,
  inboxIdeas,
  matchesFilter,
  noteLine,
  stepIdea,
  type TriageKey,
  triageKey,
} from "@/lib/inbox-triage";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";
import { FilingChoices } from "./FilingChoices.tsx";
import { NewItemLine } from "./NewItemLine.tsx";

/**
 * The inbox of Plan as a place to sort ideas (ADR-214): the line for a new idea on top, the open ideas newest first by the
 * day they were written, each with who wrote it, its repos and the first line of its notes, and on the selected one "File
 * in…", "Start task" and "Drop", also as F, S and D, with J and K to move. Dropped ideas fold below.
 */
export function InboxTriage({
  conn,
  items,
  tasks,
  filter,
  onFilter,
  selected,
  onSelect,
  onStartTask,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  tasks: readonly Task[];
  filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  onStartTask: (id: string) => void;
  onChanged: () => void;
}) {
  const [filing, setFiling] = useState<string>();
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const { open, dropped } = inboxIdeas(items);
  const shown = open.filter((idea) => matchesFilter(idea, filter));
  const now = new Date();
  // Once an idea leaves the list, the next one is selected and keeps the keyboard, so sorting goes on without the mouse.
  const leave = (id: string) => {
    const next = ideaAfter(shown, id);
    setFiling(undefined);
    onChanged();
    onSelect(next);
    if (next !== undefined) rowButtons.current.get(next)?.focus();
  };
  const file = useAction(async (id: string, project: string) => {
    await post(conn, boardApi.move, { item: id, parent: project, before: null });
    return id;
  }, leave);
  const setColumn = useAction(
    async (id: string, column: "ideas" | "dropped") => {
      await post(conn, boardApi.update, { item: id, column });
      return { id, column };
    },
    (done) => (done.column === "dropped" ? leave(done.id) : onChanged()),
  );
  const pending = file.pending || setColumn.pending;
  const select = (id: string | undefined) => {
    setFiling(undefined);
    onSelect(id);
    if (id !== undefined) rowButtons.current.get(id)?.focus();
  };
  const run = (idea: BoardItem, key: TriageKey) => {
    switch (key.kind) {
      case "next":
      case "previous":
        return select(stepIdea(shown, idea.id, key.kind === "next" ? 1 : -1));
      case "file":
        return setFiling(filing === idea.id ? undefined : idea.id);
      case "start":
        return onStartTask(idea.id);
      case "drop":
        return setColumn.run(idea.id, "dropped");
      case "file-in": {
        const choice = filingChoices(items, idea)[key.choice];
        if (choice) file.run(idea.id, choice.project.id);
      }
    }
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <InboxHeader open={open} filter={filter} onFilter={onFilter} />
      <NewItemLine
        conn={conn}
        parent={null}
        label="Write an idea and press Enter"
        onAdded={(id) => {
          onChanged();
          onSelect(id);
        }}
      />
      {open.length === 0 && (
        <p className="text-muted-foreground text-sm">No ideas waiting. Write one above, or ask an agent to note something for later.</p>
      )}
      {(file.error ?? setColumn.error) && <p className="text-destructive text-sm whitespace-pre-wrap">{file.error ?? setColumn.error}</p>}
      {ideaGroups(shown, now).map((group) => (
        <section key={group.age} aria-label={IDEA_AGE_LABELS[group.age]} className="flex flex-col gap-1">
          <h3 className="hud-label">{IDEA_AGE_LABELS[group.age]}</h3>
          <ul className="bg-card divide-y rounded-md border">
            {group.ideas.map((idea) => (
              <IdeaRow
                key={idea.id}
                idea={idea}
                tasks={tasks}
                now={now}
                selected={idea.id === selected}
                buttonRef={(button) => {
                  if (button) rowButtons.current.set(idea.id, button);
                  else rowButtons.current.delete(idea.id);
                }}
                onSelect={() => select(idea.id)}
                onKey={(press) => {
                  const key = triageKey(press, filing === idea.id);
                  if (key) run(idea, key);
                  return key !== undefined;
                }}
                actions={
                  idea.id === selected && (
                    <IdeaActions
                      filing={filing === idea.id}
                      disabled={pending}
                      onFile={() => run(idea, { kind: "file" })}
                      onStart={() => run(idea, { kind: "start" })}
                      onDrop={() => run(idea, { kind: "drop" })}
                    />
                  )
                }
                filing={
                  filing === idea.id && (
                    <FilingChoices
                      choices={filingChoices(items, idea)}
                      numbered
                      disabled={pending}
                      onFile={(project) => file.run(idea.id, project)}
                    />
                  )
                }
              />
            ))}
          </ul>
        </section>
      ))}
      <DroppedIdeas
        dropped={dropped}
        selected={selected}
        disabled={pending}
        onSelect={onSelect}
        onRestore={(id) => setColumn.run(id, "ideas")}
      />
      {open.length > 0 && (
        <p className="text-muted-foreground text-xs">
          On a selected idea: J and K move, F files it in a project (then 1–9), S starts a task, D drops it.
        </p>
      )}
    </div>
  );
}

function InboxHeader({
  open,
  filter,
  onFilter,
}: {
  open: readonly BoardItem[];
  filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-medium">Inbox</h2>
      <span className="text-muted-foreground text-sm">
        {open.length === 0 ? "Nothing to sort" : `${countLabel(open.length, { one: "idea", other: "ideas" })} to sort`}
      </span>
      <fieldset aria-label="Show ideas" className="ml-auto flex rounded-md border">
        {INBOX_FILTERS.map(({ filter: f, label }) => (
          <Button key={f} variant={f === filter ? "secondary" : "ghost"} size="sm" aria-pressed={f === filter} onClick={() => onFilter(f)}>
            {label} <span className="text-muted-foreground font-mono text-xs">{open.filter((idea) => matchesFilter(idea, f)).length}</span>
          </Button>
        ))}
      </fieldset>
    </header>
  );
}

/** The dropped ideas, folded: each can be selected to read it, or restored into the inbox. */
function DroppedIdeas({
  dropped,
  selected,
  disabled,
  onSelect,
  onRestore,
}: {
  dropped: readonly BoardItem[];
  selected: string | undefined;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (dropped.length === 0) return null;
  return (
    <section aria-label="Dropped" className="flex flex-col gap-1">
      <Button variant="ghost" size="sm" className="w-fit" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />} Dropped {dropped.length}
      </Button>
      {open && (
        <ul className="flex flex-col">
          {dropped.map((idea) => (
            <li key={idea.id} className="flex items-center gap-2 px-2 text-sm">
              <button
                type="button"
                onClick={() => onSelect(idea.id)}
                aria-current={idea.id === selected ? "true" : undefined}
                className={cn(
                  "text-muted-foreground hover:bg-accent min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left line-through",
                  idea.id === selected && "bg-accent",
                )}
              >
                {idea.title}
              </button>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onRestore(idea.id)}>
                <Undo2 /> Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IdeaRow({
  idea,
  tasks,
  now,
  selected,
  buttonRef,
  onSelect,
  onKey,
  actions,
  filing,
}: {
  idea: BoardItem;
  tasks: readonly Task[];
  now: Date;
  selected: boolean;
  buttonRef: (button: HTMLButtonElement | null) => void;
  onSelect: () => void;
  /** Whether the key did something; only then is it taken from the row. */
  onKey: (press: KeyboardEvent) => boolean;
  actions: ReactNode;
  filing: ReactNode;
}) {
  const author = ideaAuthor(idea, tasks);
  const note = noteLine(idea.body);
  return (
    <li className={cn("flex flex-col gap-2 px-3 py-2", selected && "bg-accent text-accent-foreground")}>
      <div className="flex items-start gap-2">
        <button
          ref={buttonRef}
          type="button"
          onClick={onSelect}
          onKeyDown={(e) => {
            if (onKey(e.nativeEvent)) e.preventDefault();
          }}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 flex-col gap-1 text-left"
        >
          <span className="truncate">{idea.title}</span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
            {author.agent ? (
              <>
                <Bot aria-hidden className="size-3.5" />
                <span>{author.task ? `agent in ${author.task.title ?? author.task.repo}` : "an agent"}</span>
              </>
            ) : (
              <span>you</span>
            )}
            <span>· {relativeTime(idea.createdAt, now)}</span>
            {idea.repos.map((repo) => (
              <Badge key={repo} variant="outline" className="font-mono">
                {repo}
              </Badge>
            ))}
          </span>
          {note !== "" && <span className="text-muted-foreground truncate text-sm">{note}</span>}
        </button>
        {actions}
      </div>
      {filing}
    </li>
  );
}

function IdeaActions({
  filing,
  disabled,
  onFile,
  onStart,
  onDrop,
}: {
  filing: boolean;
  disabled: boolean;
  onFile: () => void;
  onStart: () => void;
  onDrop: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="outline" size="sm" aria-expanded={filing} disabled={disabled} onClick={onFile}>
        <FolderInput /> File in… <kbd className="text-muted-foreground font-mono text-xs">F</kbd>
      </Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={onStart}>
        <GitBranch /> Start task <kbd className="text-muted-foreground font-mono text-xs">S</kbd>
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onDrop}>
        <X /> Drop <kbd className="text-muted-foreground font-mono text-xs">D</kbd>
      </Button>
    </div>
  );
}

import { type BoardItem, boardApi, type KnowledgeListEntry } from "@trackwall/protocol";
import { BookOpen, FolderKanban, Inbox } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { isClosed, type PlanPlace, projectsOf } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { inboxIdeas } from "@/lib/inbox-triage";
import { type ItemTaskIndex, progressBelow, progressLabel, tasksWaiting } from "@/lib/plan-progress";
import { STATUS_DOT_CLASS } from "@/lib/status-tone";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

/**
 * The left column of Plan: the inbox with the count of ideas still to sort, the workspace knowledge (ADR-170), the active business projects, a
 * line for a new one, the archived.
 */
export function PlanPlaces({
  conn,
  items,
  knowledge,
  taskIndex,
  place,
  onPlace,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  /** The workspace knowledge, for the count of entries waiting for the user's approval. */
  knowledge: readonly KnowledgeListEntry[];
  taskIndex: ItemTaskIndex;
  place: PlanPlace;
  onPlace: (place: PlanPlace) => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState("");
  const create = useAction(
    (name: string) => post(conn, boardApi.create, { kind: "project", title: name, column: "ready" }),
    (project) => {
      setTitle("");
      onChanged();
      onPlace({ kind: "project", id: project.id });
    },
  );
  const projects = projectsOf(items);
  const active = projects.filter((p) => !isClosed(p));
  const archived = projects.filter(isClosed);
  const isPlace = (candidate: PlanPlace) =>
    candidate.kind === place.kind && (candidate.kind !== "project" || (place.kind === "project" && place.id === candidate.id));
  const row = (key: string, target: PlanPlace, label: string, icon: ReactNode, count?: ReactNode) => (
    <li key={key}>
      <button
        type="button"
        onClick={() => onPlace(target)}
        aria-current={isPlace(target) ? "true" : undefined}
        className={cn(
          "hover:bg-accent flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm",
          isPlace(target) && "bg-accent text-accent-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count}
      </button>
    </li>
  );
  return (
    <nav aria-label="Inbox and projects" className="flex min-h-0 flex-col gap-3 overflow-y-auto pb-3">
      <ul>
        {row("inbox", { kind: "inbox" }, "Inbox", <Inbox className="size-4 shrink-0" />, <Count n={inboxIdeas(items).open.length} />)}
        {row(
          "knowledge",
          { kind: "knowledge" },
          "Workspace knowledge",
          <BookOpen className="size-4 shrink-0" />,
          <ToApprove n={knowledge.filter((entry) => !entry.approved).length} />,
        )}
      </ul>
      <div className="flex flex-col gap-1">
        <h3 className="hud-label px-4">Projects</h3>
        <ul>
          {active.map((p) =>
            row(
              p.id,
              { kind: "project", id: p.id },
              p.title,
              <FolderKanban className="size-4 shrink-0" />,
              <ProjectGlance items={items} project={p.id} taskIndex={taskIndex} />,
            ),
          )}
        </ul>
        <div className="px-4 pt-1">
          <Input
            aria-label="New project"
            placeholder="New project"
            value={title}
            disabled={create.pending}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim() !== "") create.run(title.trim());
            }}
          />
          {create.error && <p className="text-destructive pt-1 text-xs">{create.error}</p>}
        </div>
      </div>
      {archived.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="hud-label px-4">Archived</h3>
          <ul className="text-muted-foreground">
            {archived.map((p) => row(p.id, { kind: "project", id: p.id }, p.title, <FolderKanban className="size-4 shrink-0" />))}
          </ul>
        </div>
      )}
    </nav>
  );
}

/** Entries an agent proposed that wait for the user, in the warning tone, since none reaches a session before. */
function ToApprove({ n }: { n: number }) {
  return n > 0 ? (
    <span className="text-warning font-mono text-xs" title={`${n} to approve`}>
      {n}
    </span>
  ) : null;
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="text-muted-foreground font-mono text-xs">{n}</span> : null;
}

/** A project's line on the left (ADR-215): a dot while one of its tasks waits for the user, and "2/9" done. */
function ProjectGlance({ items, project, taskIndex }: { items: readonly BoardItem[]; project: string; taskIndex: ItemTaskIndex }) {
  const progress = progressBelow(items, project);
  const waiting = tasksWaiting(items, project, taskIndex);
  return (
    <>
      {waiting > 0 && (
        <span
          role="img"
          aria-label="A task waits for you"
          title="A task waits for you"
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS.warning)}
        />
      )}
      {progress.total > 0 && (
        <span className="text-muted-foreground font-mono text-xs" title={progressLabel(progress)}>
          {progress.done}/{progress.total}
        </span>
      )}
    </>
  );
}

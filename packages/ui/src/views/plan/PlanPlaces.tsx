import { type BoardItem, boardApi, childrenOf } from "@trackwall/protocol";
import { FolderKanban, Inbox } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { isArchived, type PlanPlace, projectsOf } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

/** The left column of Plan: the inbox with its count, the active business projects, a line for a new one, the archived. */
export function PlanPlaces({
  conn,
  items,
  place,
  onPlace,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
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
  const active = projects.filter((p) => !isArchived(p));
  const archived = projects.filter(isArchived);
  const isPlace = (candidate: PlanPlace) =>
    candidate.kind === place.kind && (candidate.kind === "inbox" || (place.kind === "project" && place.id === candidate.id));
  const row = (key: string, target: PlanPlace, label: string, icon: ReactNode, count?: number) => (
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
        {count !== undefined && count > 0 && <span className="text-muted-foreground font-mono text-xs">{count}</span>}
      </button>
    </li>
  );
  return (
    <nav aria-label="Inbox and projects" className="flex min-h-0 flex-col gap-3 overflow-y-auto pb-3">
      <ul>{row("inbox", { kind: "inbox" }, "Inbox", <Inbox className="size-4 shrink-0" />, childrenOf(items, null).length)}</ul>
      <div className="flex flex-col gap-1">
        <h3 className="hud-label px-4">Projects</h3>
        <ul>{active.map((p) => row(p.id, { kind: "project", id: p.id }, p.title, <FolderKanban className="size-4 shrink-0" />))}</ul>
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

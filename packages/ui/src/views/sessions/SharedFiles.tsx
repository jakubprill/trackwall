import { countLabel, type Task } from "@trackwall/protocol";
import { GitMerge, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { taskName } from "@/lib/session-entries";
import type { TaskDetails } from "@/lib/use-task-details";

/** This many paths fit on one line of the warning; the rest is a count. */
const SHOWN_FILES = 3;

/**
 * The warning above a task's tabs (ADR-44): another task of the same repo changes the same files, so the one merged
 * second may get a conflict. Where a trial merge of what both tasks committed already conflicts (ADR-230), the warning
 * names those files as conflicts. Trackwall only warns and stops nothing. The data comes from `useTaskDetails`.
 */
export function SharedFiles({ shared, onOpenTask }: { shared: TaskDetails["sharedFiles"]; onOpenTask: (id: string) => void }) {
  if (shared.length === 0) return null;
  return (
    <section aria-label="Files shared with other tasks" className="border-warning/40 bg-warning/10 flex flex-col gap-2 border-b px-4 py-3">
      {shared.map(({ files, conflicts, other }) => (
        <SharedWith key={other.id} files={files} conflicts={conflicts} other={other} onOpen={() => onOpenTask(other.id)} />
      ))}
      <p className="text-muted-foreground text-xs">{footnote(shared)}</p>
    </section>
  );
}

function footnote(shared: TaskDetails["sharedFiles"]): string {
  if (shared.some(({ conflicts }) => (conflicts?.length ?? 0) > 0))
    return "A file that conflicts: merging what both tasks committed so far conflicts there, so the task merged second will have to resolve it. A file only changed by both merges cleanly so far.";
  // `null`: git could not try the merge (older than 2.38), so nothing is known about a conflict.
  if (shared.some(({ conflicts }) => conflicts === null)) return "Both tasks change these files; the one merged second may get a conflict.";
  return "Both tasks change these files; what they committed so far merges cleanly, but the one merged second may still get a conflict.";
}

function SharedWith({ files, conflicts: tried, other, onOpen }: TaskDetails["sharedFiles"][number] & { onOpen: () => void }) {
  // Not tried (`null`) shows as shared files only.
  const conflicts = tried ?? [];
  return (
    <div className="flex flex-wrap items-start gap-3">
      {conflicts.length > 0 ? (
        <GitMerge className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">{headline(files.length, conflicts.length, other)}</p>
        <Paths paths={conflicts.length > 0 ? conflicts : files} />
      </div>
      <Button variant="outline" size="sm" onClick={onOpen}>
        Open that task
      </Button>
    </div>
  );
}

function headline(files: number, conflicts: number, other: Task): string {
  const name = `the task “${taskName(other)}”`;
  if (conflicts === 0) return `${countLabel(files, { one: "file is", other: "files are" })} also changed by ${name}`;
  const clean = files - conflicts;
  const rest = clean > 0 ? `; ${countLabel(clean, { one: "other shared file merges", other: "other shared files merge" })} cleanly` : "";
  return `${countLabel(conflicts, { one: "file conflicts", other: "files conflict" })} with ${name}${rest}`;
}

function Paths({ paths }: { paths: readonly string[] }) {
  const rest = paths.length - SHOWN_FILES;
  return (
    <p className="text-muted-foreground truncate font-mono text-xs" title={paths.join("\n")}>
      {paths.slice(0, SHOWN_FILES).join(" · ")}
      {rest > 0 && ` · ${rest} more`}
    </p>
  );
}

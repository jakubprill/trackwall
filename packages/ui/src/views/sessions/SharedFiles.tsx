import { GitMerge, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { taskName } from "@/lib/session-entries";
import { sharedFilesFootnote, sharedFilesHeadline } from "@/lib/shared-files";
import type { TaskDetails } from "@/lib/use-task-details";

/** This many paths fit on one line of the warning; the rest is a count. */
const SHOWN_FILES = 3;

/**
 * The warning above a task's tabs (ADR-44): another task of the same repo changes the same files, so the one merged
 * second may get a conflict. Where a trial merge of what both tasks committed already conflicts (ADR-230), the warning
 * names those files as conflicting. Trackwall only warns and stops nothing. The data comes from `useTaskDetails`.
 */
export function SharedFiles({ shared, onOpenTask }: { shared: TaskDetails["sharedFiles"]; onOpenTask: (id: string) => void }) {
  if (shared.length === 0) return null;
  return (
    <section aria-label="Files shared with other tasks" className="border-warning/40 bg-warning/10 flex flex-col gap-2 border-b px-4 py-3">
      {shared.map(({ files, conflicts, other }) => (
        <SharedWith key={other.id} files={files} conflicts={conflicts} other={other} onOpen={() => onOpenTask(other.id)} />
      ))}
      <p className="text-muted-foreground text-xs">
        {sharedFilesFootnote(shared.map(({ files, conflicts }) => ({ files: files.length, conflicts: conflicts?.length ?? null })))}
      </p>
    </section>
  );
}

function SharedWith({ files, conflicts, other, onOpen }: TaskDetails["sharedFiles"][number] & { onOpen: () => void }) {
  const conflicting = conflicts !== null && conflicts.length > 0;
  const counts = { files: files.length, conflicts: conflicts?.length ?? null };
  return (
    <div className="flex flex-wrap items-start gap-3">
      {conflicting ? (
        <GitMerge className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">{sharedFilesHeadline(counts, `the task “${taskName(other)}”`)}</p>
        <Paths paths={conflicting ? conflicts : files} />
      </div>
      <Button variant="outline" size="sm" onClick={onOpen}>
        Open that task
      </Button>
    </div>
  );
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

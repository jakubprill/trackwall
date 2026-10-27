import { countLabel, type Task, type TaskSharedFiles } from "@trackwall/protocol";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { taskName } from "@/lib/session-entries";
import type { TaskDetails } from "@/lib/use-task-details";

/** This many paths fit on one line of the warning; the rest is a count. */
const SHOWN_FILES = 3;

/**
 * The warning above a task's tabs (ADR-44): another task of the same repo changes the same files, so the one merged
 * second will likely get a conflict. Trackwall only warns and stops nothing. The data comes from `useTaskDetails`.
 */
export function SharedFiles({ shared, onOpenTask }: { shared: TaskDetails["sharedFiles"]; onOpenTask: (id: string) => void }) {
  if (shared.length === 0) return null;
  return (
    <section aria-label="Files shared with other tasks" className="border-warning/40 bg-warning/10 flex flex-col gap-2 border-b px-4 py-3">
      {shared.map(({ files, other }) => (
        <SharedWith key={other.id} files={files} other={other} onOpen={() => onOpenTask(other.id)} />
      ))}
      <p className="text-muted-foreground text-xs">Both tasks change these files; the one merged second will likely get a conflict.</p>
    </section>
  );
}

function SharedWith({ files, other, onOpen }: { files: TaskSharedFiles["files"]; other: Task; onOpen: () => void }) {
  const rest = files.length - SHOWN_FILES;
  return (
    <div className="flex flex-wrap items-start gap-3">
      <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">
          {`${countLabel(files.length, { one: "file is", other: "files are" })} also changed by the task “${taskName(other)}”`}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs" title={files.join("\n")}>
          {files.slice(0, SHOWN_FILES).join(" · ")}
          {rest > 0 && ` · ${rest} more`}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onOpen}>
        Open that task
      </Button>
    </div>
  );
}

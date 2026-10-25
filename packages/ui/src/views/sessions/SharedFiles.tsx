import { agentsApi, countLabel, type Task, type TaskSharedFiles } from "@trackwall/protocol";
import { TriangleAlert } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { taskName } from "@/lib/session-entries";
import { useRemote } from "@/lib/use-remote";

/** An agent changes files within seconds, but the warning need not be instant, and one request reads git of every task in the repo. */
const POLL_MS = 5000;
/** This many paths fit on one line of the warning; the rest is a count. */
const SHOWN_FILES = 3;

/**
 * The warning above a task's tabs (ADR-44): another task of the same repo changes the same files, so the one merged
 * second will likely get a conflict. Trackwall only warns and stops nothing. Since it is only a warning, a failed
 * request shows nothing; the reason, if it is the task's own changes, is in the “Changes” tab.
 */
export function SharedFiles({
  conn,
  task,
  tasks,
  paused,
  onOpenTask,
}: {
  conn: Connection;
  task: string;
  /** All tasks on the list, to name the other task. */
  tasks: readonly Task[];
  paused: boolean;
  onOpenTask: (id: string) => void;
}) {
  const load = useCallback(() => post(conn, agentsApi.taskSharedFiles, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: POLL_MS });
  // A failed request hides a warning from an earlier one, which may no longer be true.
  const shown = (remote.error ? [] : (remote.data?.shared ?? [])).flatMap((shared) => {
    const other = tasks.find((t) => t.id === shared.task);
    return other ? [{ shared, other }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <section aria-label="Files shared with other tasks" className="border-warning/40 bg-warning/10 flex flex-col gap-2 border-b px-4 py-3">
      {shown.map(({ shared, other }) => (
        <SharedWith key={other.id} files={shared.files} other={other} onOpen={() => onOpenTask(other.id)} />
      ))}
      <p className="text-muted-foreground text-xs">Both tasks change these files; the one merged second will likely get a conflict.</p>
    </section>
  );
}

function SharedWith({ files, other, onOpen }: { files: TaskSharedFiles["files"]; other: Task; onOpen: () => void }) {
  const rest = files.length - SHOWN_FILES;
  return (
    <div className="flex items-start gap-3">
      <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
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

import { miseApi, miseTaskLogSource, type RunningMiseTask } from "@trackwall/protocol";
import { ScrollText, Square } from "lucide-react";
import { useCallback, useState } from "react";
import { MiseTaskLog } from "@/components/MiseTaskLog";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { relativeTime } from "@/lib/format";
import { RUNNING_MISE_POLL_MS } from "@/lib/run-state";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * The mise tasks running in a task's worktree (ADR-59), started by its agent over MCP: the user watches their log and
 * stops them here, as the repo's "mise tasks" tab does for the repo root. Hidden while nothing runs. A run the
 * verification section already shows with its log and Cancel (ADR-64) is left out, so it is not listed twice.
 */
export function TaskMiseRuns({
  conn,
  task,
  live,
  paused,
  shownElsewhere,
}: {
  conn: Connection;
  task: string;
  live: LiveFeed<RunningMiseTask[]> | undefined;
  paused: boolean;
  /** The mise task whose run another section of the panel shows (the running verification's `test`). */
  shownElsewhere: string | undefined;
}) {
  const load = useCallback(() => post(conn, miseApi.running, {}), [conn]);
  const remote = useRemote(paused ? undefined : load, { pollMs: RUNNING_MISE_POLL_MS, live });
  const runs = (remote.data ?? []).filter((r) => r.task === task && r.miseTask !== shownElsewhere);
  if (runs.length === 0) return null;
  return (
    <section aria-label="mise tasks in this worktree" className="flex flex-col gap-2 border-b px-4 py-3">
      <span className="hud-label">mise tasks in this worktree</span>
      {runs.map((run) => (
        <TaskMiseRun key={run.miseTask} conn={conn} running={run} />
      ))}
    </section>
  );
}

function TaskMiseRun({ conn, running }: { conn: Connection; running: RunningMiseTask }) {
  const [showLog, setShowLog] = useState(false);
  const { repo, task, miseTask, run } = running;
  const stop = useAction(
    () => post(conn, miseApi.stop, { repo, task, miseTask }),
    () => {},
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm">{miseTask}</span>
        <span className="text-muted-foreground flex-1 text-xs">
          {run.kind === "stopping" ? "stopping" : `running, started ${relativeTime(run.startedAt, new Date())}`}
        </span>
        {stop.error && <span className="text-destructive max-w-xs truncate text-xs">{stop.error}</span>}
        <Button variant="ghost" size="sm" onClick={() => setShowLog((shown) => !shown)} aria-pressed={showLog}>
          <ScrollText /> Log
        </Button>
        <Button variant="outline" size="sm" onClick={stop.run} disabled={stop.pending || run.kind === "stopping"}>
          <Square /> Stop
        </Button>
      </div>
      {showLog && <MiseTaskLog conn={conn} source={miseTaskLogSource(repo, task, miseTask)} />}
    </div>
  );
}

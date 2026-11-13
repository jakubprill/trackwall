import { type TaskRefresh, taskRefreshApi } from "@trackwall/protocol";
import { GitMerge } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { refreshMessage } from "@/lib/task-refresh";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

/**
 * "Refresh from <base branch>" in the task's "Changes" tab (ADR-244): merges the newest commits of the branch the task
 * started from into the task branch. The daemon refuses it in the middle of a turn and changes nothing when the merge
 * would conflict; the bar shows what it did.
 */
export function TaskRefreshBar({
  conn,
  task,
  baseBranch,
  onRefreshed,
}: {
  conn: Connection;
  task: string;
  baseBranch: string;
  onRefreshed: () => void;
}) {
  const [result, setResult] = useState<TaskRefresh | null>(null);
  const refresh = useAction(
    () => post(conn, taskRefreshApi.refreshTask, { task }),
    (done) => {
      setResult(done);
      if (done.state === "refreshed") onRefreshed();
    },
  );
  const message = result && refreshMessage(result);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={refresh.pending}
        onClick={() => refresh.run()}
        title={`Merge the newest commits of ${baseBranch} into the task branch`}
      >
        <GitMerge /> {refresh.pending ? "Refreshing…" : `Refresh from ${baseBranch}`}
      </Button>
      {message && !refresh.pending && (
        <p className={cn("text-sm break-words", message.tone === "warning" ? "text-warning" : "text-muted-foreground")}>{message.text}</p>
      )}
      {refresh.error && <p className="text-destructive text-sm break-words">{refresh.error}</p>}
    </div>
  );
}

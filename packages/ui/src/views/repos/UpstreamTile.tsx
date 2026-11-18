import { type PullResult, type RepoStatusOk, workspaceApi } from "@trackwall/protocol";
import { ArrowDown, ArrowUp, RotateCw } from "lucide-react";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { folderWorkWarning, pullLabel, pullResultLine, upstreamOffer } from "@/lib/upstream-pull";

/** The pull's own state: running, its result or error, or the question asked first when something works in the folder. */
type PullState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "running" }
  | { kind: "done"; result: PullResult }
  | { kind: "failed"; message: string };

/**
 * The Upstream tile of the repo header (ADR-269): the checked-out branch against the branch it tracks, and the pull that
 * moves it there. When it will not pull, it says why and leads to the tab that gets the user out (Changes or Shell).
 * The new status comes with the repo list, which sees the moved HEAD.
 */
export function UpstreamTile({
  conn,
  repo,
  status,
  workInFolder,
  onShowChanges,
  onOpenShell,
}: {
  conn: Connection;
  repo: string;
  status: RepoStatusOk;
  /** What works in the repo folder itself (`workInRepoFolder`); the pull asks first when it is not empty. */
  workInFolder: readonly string[];
  onShowChanges: () => void;
  onOpenShell: () => void;
}) {
  const [pull, setPull] = useState<PullState>({ kind: "idle" });
  const offer = upstreamOffer(status);
  const run = () => {
    setPull({ kind: "running" });
    post(conn, workspaceApi.pull, { repo }).then(
      (result) => setPull({ kind: "done", result }),
      (err: unknown) => setPull({ kind: "failed", message: errorMessage(err) }),
    );
  };
  const start = () => (workInFolder.length > 0 ? setPull({ kind: "asking" }) : run());

  return (
    <div className="surface flex min-w-0 flex-col gap-1 px-3 py-2">
      <dt className="hud-label">Upstream</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-sm">
        {status.upstream ? (
          <span className="flex min-w-0 items-center gap-2 font-mono" title={`compared with ${status.upstream.name}`}>
            <span className="flex items-center gap-0.5">
              <ArrowUp className="text-muted-foreground size-3.5" />
              {status.upstream.ahead}
            </span>
            <span className="flex items-center gap-0.5">
              <ArrowDown className="text-muted-foreground size-3.5" />
              {status.upstream.behind}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">{status.upstream.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
        {offer.kind === "pull" && pull.kind !== "asking" && (
          <Button
            size="sm"
            className="h-7 self-start"
            disabled={pull.kind === "running"}
            onClick={start}
            title={`Fetch, then fast-forward ${status.branch} to ${status.upstream?.name}; the default branch is synced as in Sync all`}
          >
            {pull.kind === "running" ? <RotateCw className="animate-spin" /> : <ArrowDown />}
            {pull.kind === "running" ? "Pulling…" : pullLabel(offer.behind)}
          </Button>
        )}
        {offer.kind === "blocked" && pull.kind !== "running" && (
          <span className="flex flex-col items-start gap-1 text-xs">
            <span className="text-warning">{offer.message}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary h-6 px-1"
              onClick={offer.way === "changes" ? onShowChanges : onOpenShell}
            >
              {offer.way === "changes" ? "Show changes" : "Open Shell"}
            </Button>
          </span>
        )}
        {pull.kind === "asking" && (
          <span className="flex flex-col gap-1 text-xs">
            <span className="text-warning">{folderWorkWarning(workInFolder)}</span>
            <span className="flex gap-2">
              <Button size="sm" className="h-7" onClick={run}>
                Pull anyway
              </Button>
              <Button variant="outline" size="sm" className="h-7" onClick={() => setPull({ kind: "idle" })}>
                Cancel
              </Button>
            </span>
          </span>
        )}
        {pull.kind === "done" && <StatusLabel {...pullResultLine(pull.result)} className="text-xs whitespace-normal" />}
        {pull.kind === "failed" && (
          <span className="flex flex-col items-start gap-1 text-xs">
            <span className="text-destructive whitespace-pre-wrap break-words">Pull failed: {pull.message}</span>
            <Button variant="outline" size="sm" className="h-7" onClick={run}>
              <RotateCw /> Retry
            </Button>
          </span>
        )}
      </dd>
    </div>
  );
}

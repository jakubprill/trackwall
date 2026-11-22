import type { RepoStatusOk } from "@trackwall/protocol";
import { ArrowDown, ArrowUp } from "lucide-react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { NEW_ON_SERVER } from "@/lib/repo-status";
import { pullResultLine, type UpstreamOffer, upstreamOffer } from "@/lib/upstream-pull";
import { usePull } from "@/lib/use-pull";
import { cn } from "@/lib/utils";
import { PullButton, PullFailure, PullQuestion } from "./PullControls.tsx";
import { PutAsideConfirm } from "./PutAsideConfirm.tsx";

/**
 * The Upstream tile of the repo header (ADR-269): the checked-out branch against the branch it tracks, and the pull that
 * moves it there. When it will not pull, it says why and leads to the tab that gets the user out (Changes or Shell).
 * Commits only the server check knows of (ADR-295) get the pull too, without a number: the counts are the last fetch's.
 * The new status comes with the repo list, which sees the moved HEAD.
 */
export function UpstreamTile({
  conn,
  repo,
  status,
  newOnServer,
  workInFolder,
  onShowChanges,
  onOpenShell,
}: {
  conn: Connection;
  repo: string;
  status: RepoStatusOk;
  /** The server check found commits the repo has not fetched (`newOnServerSince`). */
  newOnServer: boolean;
  /** What works in the repo folder itself (`workInRepoFolder`); the pull asks first when it is not empty. */
  workInFolder: readonly string[];
  onShowChanges: () => void;
  onOpenShell: () => void;
}) {
  const pull = usePull(conn, repo, workInFolder);
  const { state } = pull;
  const offer = upstreamOffer(status, newOnServer);

  return (
    <div className={cn("surface flex min-w-0 flex-col gap-1 px-3 py-2", state.kind === "putting-aside" && "col-span-full")}>
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
        {offer.kind === "pull" && offer.behind === null && <StatusLabel tone="warning" label={NEW_ON_SERVER} className="text-xs" />}
        {offer.kind === "pull" && state.kind !== "asking" && <PullButton offer={offer} pull={pull} className="self-start" />}
        {offer.kind === "blocked" && state.kind !== "running" && state.kind !== "putting-aside" && (
          <BlockedOffer offer={offer} onPutAside={pull.putAside} onShowChanges={onShowChanges} onOpenShell={onOpenShell} />
        )}
        {state.kind === "putting-aside" && (
          <PutAsideConfirm conn={conn} targets={[{ repo, workInFolder }]} verb="pull" onClose={pull.reset} />
        )}
        {state.kind === "asking" && <PullQuestion workInFolder={workInFolder} pull={pull} />}
        {state.kind === "done" && <StatusLabel {...pullResultLine(state.result)} className="text-xs whitespace-normal" />}
        {state.kind === "failed" && <PullFailure message={state.message} pull={pull} />}
      </dd>
    </div>
  );
}

/** Why the tile does not pull, with the way out: put the changes aside or look at them, or the Shell for a diverged branch. */
function BlockedOffer({
  offer,
  onPutAside,
  onShowChanges,
  onOpenShell,
}: {
  offer: Extract<UpstreamOffer, { kind: "blocked" }>;
  onPutAside: () => void;
  onShowChanges: () => void;
  onOpenShell: () => void;
}) {
  return (
    <span className="flex flex-col items-start gap-1 text-xs">
      <span className="text-warning">{offer.message}</span>
      {offer.way === "changes" ? (
        <span className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" className="h-7" onClick={onPutAside}>
            Put aside and pull…
          </Button>
          <Button variant="ghost" size="sm" className="text-primary h-7 px-1" onClick={onShowChanges}>
            Show changes
          </Button>
        </span>
      ) : (
        <Button variant="ghost" size="sm" className="text-primary h-6 px-1" onClick={onOpenShell}>
          Open Shell
        </Button>
      )}
    </span>
  );
}

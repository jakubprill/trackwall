import { Button } from "@/components/ui/button";
import { availableText, inTurnText, waitingText } from "@/lib/updates";
import type { AppUpdateHandle } from "@/lib/use-app-update";

/**
 * An update that is available or waits for the agents' turns (ADR-53, ADR-97): with no agent in the middle of a turn,
 * "Update and restart"; otherwise "Update after their turn", which installs once the last turn ends, and "Update now".
 * In the strip above the views (with "Later") and in "Settings > Updates".
 */
export function UpdateOffer({ handle, onLater }: { handle: AppUpdateHandle; onLater?: () => void }) {
  const { update, install, agentsInTurn, waitForTurns, cancelWaiting } = handle;
  if (update.state === "waiting")
    return (
      <>
        <p className="min-w-0 flex-1 text-sm" aria-live="polite">
          {waitingText(update, agentsInTurn ?? 0)}
        </p>
        <Button variant="outline" size="sm" onClick={() => install(update.version)}>
          Update now
        </Button>
        <Button variant="ghost" size="sm" onClick={cancelWaiting}>
          Cancel
        </Button>
      </>
    );
  if (update.state !== "available") return null;
  const busy = agentsInTurn !== undefined && agentsInTurn > 0;
  return (
    <>
      <p className="min-w-0 flex-1 text-sm">
        {availableText(update)}
        {busy && ` ${inTurnText(agentsInTurn)}`}
      </p>
      {busy ? (
        <>
          <Button size="sm" onClick={waitForTurns}>
            Update after their turn
          </Button>
          <Button variant="outline" size="sm" onClick={() => install(update.version)}>
            Update now
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => install(update.version)}>
          Update and restart
        </Button>
      )}
      {onLater && (
        <Button variant="ghost" size="sm" onClick={onLater}>
          Later
        </Button>
      )}
    </>
  );
}

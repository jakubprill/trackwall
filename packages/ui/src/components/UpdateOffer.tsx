import { Button } from "@/components/ui/button";
import { type Available, type OfferAction, updateOffer } from "@/lib/updates";
import type { AppUpdateHandle } from "@/lib/use-app-update";

const VARIANTS: Record<OfferAction, "default" | "outline" | "ghost"> = {
  restart: "default",
  "after-turns": "default",
  now: "outline",
  "cancel-waiting": "ghost",
};

const LABELS: Record<OfferAction, string> = {
  restart: "Update and restart",
  "after-turns": "Update after their turn",
  now: "Update now",
  "cancel-waiting": "Cancel",
};

/**
 * An available update with its buttons (ADR-53, ADR-97, `updateOffer` decides them), in the strip above the views (with
 * "Later" until the user chose to wait for the agents' turns) and in "Settings > Updates".
 */
export function UpdateOffer({ handle, update, onLater }: { handle: AppUpdateHandle; update: Available; onLater?: () => void }) {
  const { install, agentsInTurn, waitForTurns, cancelWaiting } = handle;
  const { text, actions } = updateOffer(update, agentsInTurn);
  const run: Record<OfferAction, () => void> = {
    restart: () => install(update.version),
    "after-turns": waitForTurns,
    now: () => install(update.version),
    "cancel-waiting": cancelWaiting,
  };
  return (
    <>
      <p className="min-w-0 flex-1 text-sm" aria-live="polite">
        {text}
      </p>
      {actions.map((action) => (
        <Button key={action} variant={VARIANTS[action]} size="sm" onClick={run[action]}>
          {LABELS[action]}
        </Button>
      ))}
      {onLater && !update.afterTurns && (
        <Button variant="ghost" size="sm" onClick={onLater}>
          Later
        </Button>
      )}
    </>
  );
}

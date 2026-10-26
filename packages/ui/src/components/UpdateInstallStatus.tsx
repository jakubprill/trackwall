import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { canCancel, downloadedFraction, type Installing, installingText, stallText } from "@/lib/updates";

/** How often the clock ticks, so that a stalled download says how long it has been silent. */
const CLOCK_MS = 1000;

/**
 * The install of an update as it goes (ADR-53): the stage with the download's size and speed, a bar while the size is
 * known, a note when the download has stalled, and "Cancel" until the package is in. Shown in the strip above the views
 * and in "Settings > Updates".
 */
export function UpdateInstallStatus({ update, cancel }: { update: Installing; cancel: () => void }) {
  // Here and not in the app's update state, so that the tick re-renders only this line while an install runs.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(clock);
  }, []);
  const fraction = update.stage.stage === "downloading" ? downloadedFraction(update.stage) : undefined;
  const stall = stallText(update, now);
  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm" aria-live="polite">
          {installingText(update, now)}
        </p>
        {canCancel(update) && (
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
        )}
      </div>
      {fraction !== undefined && (
        <div
          className="bg-muted h-1.5 w-full max-w-md overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(fraction * 100)}
        >
          <div className="bg-primary h-full" style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
      {stall && <p className="text-destructive text-sm">{stall}</p>}
    </div>
  );
}

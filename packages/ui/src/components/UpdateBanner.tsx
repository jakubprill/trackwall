import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { progressLabel, RESTART_WARNING } from "@/lib/updates";
import type { AppUpdateHandle } from "@/lib/use-app-update";

/** Strip above the views while a newer version is available or being installed; "Later" hides it until the next version. */
export function UpdateBanner({ handle }: { handle: AppUpdateHandle }) {
  const [dismissed, setDismissed] = useState<string>();
  const { update, install } = handle;
  if (update.state === "installing") {
    return (
      <Strip>
        <p className="min-w-0 flex-1 text-sm">
          Installing Trackwall {update.version}
          {update.progress ? `: ${progressLabel(update.progress)}` : "…"} The app restarts on its own.
        </p>
      </Strip>
    );
  }
  if (update.state === "failed" && update.version) {
    const { version } = update;
    return (
      <Strip>
        <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{update.message}</p>
        <Button variant="outline" size="sm" onClick={() => install(version)}>
          Try again
        </Button>
      </Strip>
    );
  }
  if (update.state !== "available" || dismissed === update.version) return null;
  return (
    <Strip>
      <p className="min-w-0 flex-1 text-sm">
        Trackwall {update.version} is available (you have {update.currentVersion}). {RESTART_WARNING}
      </p>
      <Button size="sm" onClick={() => install(update.version)}>
        Update and restart
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setDismissed(update.version)}>
        Later
      </Button>
    </Strip>
  );
}

function Strip({ children }: { children: ReactNode }) {
  return <div className="bg-primary/10 flex items-center gap-3 border-b px-4 py-2">{children}</div>;
}

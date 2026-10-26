import type { ReactNode } from "react";
import { UpdateInstallStatus } from "@/components/UpdateInstallStatus";
import { Button } from "@/components/ui/button";
import { availableText } from "@/lib/updates";
import type { AppUpdateHandle } from "@/lib/use-app-update";

/** Strip above the views while a newer version is available or being installed (ADR-53). */
export function UpdateBanner({ handle: { update, install, cancel, dismissed, dismiss } }: { handle: AppUpdateHandle }) {
  switch (update.state) {
    case "installing":
      return (
        <Strip>
          <UpdateInstallStatus update={update} cancel={cancel} />
        </Strip>
      );
    case "install-failed":
      return (
        <Strip>
          <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{update.message}</p>
          <Button variant="outline" size="sm" onClick={() => install(update.version)}>
            Try again
          </Button>
        </Strip>
      );
    case "available":
      if (dismissed === update.version) return null;
      return (
        <Strip>
          <p className="min-w-0 flex-1 text-sm">{availableText(update)}</p>
          <Button size="sm" onClick={() => install(update.version)}>
            Update and restart
          </Button>
          <Button variant="ghost" size="sm" onClick={() => dismiss(update.version)}>
            Later
          </Button>
        </Strip>
      );
    default:
      return null;
  }
}

function Strip({ children }: { children: ReactNode }) {
  return <div className="bg-primary/10 flex items-center gap-3 border-b px-4 py-2">{children}</div>;
}

import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { inDesktopShell } from "@/lib/app-window";
import { askForNotifications, type NotificationAccess, useNotificationAccess } from "@/lib/browser-notifications";

/** Browser notifications of Trackwall in a browser tab (ADR-146); the desktop app shows system notifications itself. */
export function BrowserNotificationsSurface() {
  return (
    <Surface label="Notifications in the browser">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Trackwall in a browser tab shows how many sessions and task proposals wait for you in the tab's title, and a notification when one
          starts waiting while you are in another tab or window.
        </p>
        {inDesktopShell() ? <p className="text-sm">The desktop app shows system notifications without this.</p> : <AccessState />}
      </div>
    </Surface>
  );
}

const ACCESS_TEXT: Record<Exclude<NotificationAccess, "default">, string> = {
  granted: "On in this browser. To turn them off, block notifications for this page in the browser's site settings.",
  denied: "Blocked in this browser. Allow notifications for this page in the browser's site settings; the title still counts.",
  unsupported: "This browser cannot show notifications; the title still counts.",
};

function AccessState() {
  const access = useNotificationAccess();
  if (access !== "default") return <p className="text-sm">{ACCESS_TEXT[access]}</p>;
  return (
    <div>
      <Button size="sm" onClick={() => void askForNotifications().catch(() => undefined)}>
        Turn on notifications
      </Button>
    </div>
  );
}
